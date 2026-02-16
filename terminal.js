const SOCKET_URL = 'wss://agentic-universe-server.onrender.com/ws'

let streamingController
let messageQueue = []
let isProcessingQueue = false
let worldData = null // Store world data received from parent
let socket = null
let currentSessionId = null
let reconnecting = false
let didResumeFallback = false
let streamLogBuffer = ''
let generationIndicatorInterval = null
let generationIndicatorLineIndex = null
let generationIndicatorStep = 0

const DEV_FORCE_FRESH_GAME = (() => {
	const query = new URLSearchParams(window.location.search)
	if (query.has('fresh')) return query.get('fresh') !== '0'
	return ['localhost', '127.0.0.1'].includes(window.location.hostname)
})()
const NO_SESSION_IN_DEV = DEV_FORCE_FRESH_GAME

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const generationResultTypes = new Set([
	'narrate',
	'npc_reply',
	'say_error',
	'error',
	'say_stream_start',
	'game_end'
])

function isSocketOpen() {
	return socket && socket.readyState === WebSocket.OPEN
}

function sendSocketMessage(type, message) {
	if (!isSocketOpen()) return false
	socket.send(JSON.stringify({type, message}))
	return true
}

function sendStartMessage() {
	return sendSocketMessage('start', {world: worldData})
}

function sendResumeMessage(sessionId) {
	return sendSocketMessage('resume', {session_id: sessionId})
}

function sessionStorageKey() {
	const worldName = worldData?.name || 'default'
	return `reason-os-session-id:${worldName}`
}

function loadStoredSessionId() {
	if (NO_SESSION_IN_DEV) return null
	return sessionStorage.getItem(sessionStorageKey())
}

function saveSessionId(sessionId) {
	currentSessionId = sessionId
	if (NO_SESSION_IN_DEV) return
	sessionStorage.setItem(sessionStorageKey(), sessionId)
}

function clearSessionId() {
	currentSessionId = null
	sessionStorage.removeItem(sessionStorageKey())
}

function updateGenerationIndicatorLine() {
	if (generationIndicatorLineIndex === null) return
	const output = term.find('.terminal-output')
	const lines = output.children('div')
	const line = lines[generationIndicatorLineIndex]
	if (!line) return
	const dotCount = (generationIndicatorStep % 3) + 1
	const dots = '.'.repeat(dotCount)
	$(line).html(`<span style="color: #888;">${dots}</span>`)
	generationIndicatorStep += 1
}

function startGenerationIndicator() {
	stopGenerationIndicator()
	term.echo('', {raw: true})
	const output = term.find('.terminal-output')
	const lines = output.children('div')
	generationIndicatorLineIndex = lines.length - 1
	generationIndicatorStep = 0
	updateGenerationIndicatorLine()
	generationIndicatorInterval = setInterval(updateGenerationIndicatorLine, 350)
}

function stopGenerationIndicator() {
	if (generationIndicatorInterval) {
		clearInterval(generationIndicatorInterval)
		generationIndicatorInterval = null
	}
	if (generationIndicatorLineIndex !== null) {
		const output = term.find('.terminal-output')
		const lines = output.children('div')
		const line = lines[generationIndicatorLineIndex]
		if (line) {
			$(line).remove()
		}
		generationIndicatorLineIndex = null
	}
	generationIndicatorStep = 0
}

function resetClientGameState() {
	stopGenerationIndicator()
	gameLog = []
	currentGameState = {
		currentRoom: null,
		currentChapter: null
	}
	sendGameLogToParent()
}

// Game log for parent iframe communication
let gameLog = []
let currentGameState = {
	currentRoom: null,
	currentChapter: null
}

// Add entry to game log
function addToGameLog(type, data) {
	gameLog.push({
		timestamp: new Date().toISOString(),
		type: type,
		data: data
	})
	sendGameLogToParent()
}

// Send game log to parent iframe
function sendGameLogToParent() {
	window.parent.postMessage({
		type: 'GAME_LOG',
		log: {
			entries: gameLog
		}
	}, '*')
}

// Send END signal to parent iframe
function sendEndToParent() {
	window.parent.postMessage({
		type: 'END'
	}, '*')
}

// TERMINAL
let term = $('#terminal').terminal(interpreter, {
	name: 'Reason OS',
	greetings: 'Loading world data...',
	prompt: '\n>',
	clear: false,
	convertLinks: false,
	onInit: connectSocket,
}).click()

streamingController = createStreamingController(term)

// Listen for messages from parent window (iframe communication)
window.addEventListener('message', (event) => {
	if (event.data.type === 'INIT_GAME') {
		console.log('[INFO] Received INIT_GAME from parent')
		worldData = event.data.world
		if (NO_SESSION_IN_DEV) {
			clearSessionId()
		}
		
		// If socket is already connected, start the game
		if (isSocketOpen()) {
			startWithWorld()
		}
		// Otherwise, the game will start when socket connects
	}
})

// INTERPRETER
function interpreter(command, term) {
	if (!isSocketOpen()) {
		console.log('[INFO] Message received but WebSocket is not open, reconnecting...')
		connectSocket()
		return
	}
	const trimmed = command.trim()
	if (trimmed === '') return

	if (trimmed.toLowerCase() === '/new') {
		startFreshGame()
		return
	}
	
	// Log player input
	addToGameLog('player_message', trimmed)
	
	sendSocketMessage('player_input', trimmed)
	startGenerationIndicator()
	term.echo('')
}

function startFreshGame() {
	if (!worldData) {
		showWorldDataError()
		return
	}
	clearSessionId()
	didResumeFallback = false
	resetClientGameState()
	term.clear()
	updateRoomImage(null)
	term.echo('<span style="color: #888;">Starting a fresh game...</span>', {raw: true})
	term.echo('')
	sendStartMessage()
}

function startWithWorld() {
	if (!worldData) {
		console.log('[ERROR] No world data available')
		showWorldDataError()
		return
	}
	
	if (isSocketOpen()) {
		const storedSessionId = currentSessionId || loadStoredSessionId()
		if (!NO_SESSION_IN_DEV && storedSessionId) {
			console.log(`[INFO] Attempting to resume session ${storedSessionId}`)
			sendResumeMessage(storedSessionId)
			return
		}
		console.log('[INFO] Starting fresh game with world data')
		sendStartMessage()
	} else {
		console.log('[INFO] Socket not ready, will start when connected')
	}
}

function showWorldDataError() {
	if (term) {
		term.clear()
		const errorHtml = `<span style="color: #ff4444; font-weight: bold;">ERROR: No world data provided.</span>`
		term.echo(errorHtml, {raw: true})
		term.echo('')
		const detailHtml = `<span style="color: #ff6666;">This game client expects world data from a parent platform via INIT_GAME message.</span>`
		term.echo(detailHtml, {raw: true})
		term.echo('')
		const instructionHtml = `<span style="color: #888888;">If you are the developer, ensure the parent iframe sends:<br>window.postMessage({ type: 'INIT_GAME', world: {...} }, '*')</span>`
		term.echo(instructionHtml, {raw: true})
	}
}

// WEBSOCKET
function connectSocket() {
	
	socket = new WebSocket(SOCKET_URL)

	socket.onmessage = (event) => {
		const data = JSON.parse(event.data);
		messageQueue.push(data);
		processMessageQueue();
	}

	socket.onopen = () => {
		console.clear()
		console.log('[INFO] WebSocket connected')
		if (term && !reconnecting) {
			term.clear();
		}
		reconnecting = false
		didResumeFallback = false
		// Only start if we already have world data from parent
		if (worldData) {
			startWithWorld();
		} else {
			console.log('[INFO] WebSocket ready, waiting for INIT_GAME from parent');
			term.echo('Connected. Waiting for game data...');
			
			// Show error after timeout if no world data received
			setTimeout(() => {
				if (!worldData) {
					showWorldDataError();
				}
			}, 5000);
		}
	};

	socket.onclose = () => {
		console.log('[INFO] WebSocket connection lost');
		stopGenerationIndicator()
		reconnecting = true
		connectSocket();
	};

	socket.onerror = () => {
		console.log('[ERROR] WebSocket error');
		stopGenerationIndicator()
	};

	return socket;
}

async function processMessageQueue() {
	if (isProcessingQueue) return;
	isProcessingQueue = true;

	while (messageQueue.length > 0) {
		const data = messageQueue.shift();
		const message = data.message;
		if (generationResultTypes.has(data.type)) {
			stopGenerationIndicator()
		}

		switch (data.type) {
			case 'session_started':
				console.log(`[SESSION] Started: ${data.session_id}`)
				if (data.session_id) saveSessionId(data.session_id)
				break

			case 'session_resumed':
				console.log(`[SESSION] Resumed: ${data.session_id}`)
				if (data.session_id) saveSessionId(data.session_id)
				break

			case 'session_resume_failed':
				console.log(`[SESSION] Resume failed: ${message || ''}`)
				clearSessionId()
				if (!didResumeFallback && isSocketOpen()) {
					didResumeFallback = true
					console.log('[SESSION] Falling back to fresh start')
					sendStartMessage()
				}
				break

			case 'debug_action':
				// Backend action chain debug logging
				console.log('%c[BACKEND ACTION]', 'color: #ff9900; font-weight: bold; background: #1a1a1a; padding: 2px 6px; border-radius: 3px', data.action?.type, data.action);
				break;

			case 'debug_llm_response':
				// Raw LLM output debug logging
				console.groupCollapsed(`%c[LLM RESPONSE] ${data.source} %c${data.model || ''}`, 'color: #00ccff; font-weight: bold; background: #1a1a1a; padding: 2px 6px; border-radius: 3px', 'color: #888; font-weight: normal');
				console.log('%cModel:', 'color: #aaa; font-weight: bold', data.model);
				console.log('%cThinking:', 'color: #aaa; font-weight: bold', data.response?.thinking);
				console.log('%cImportance:', 'color: #aaa; font-weight: bold', data.response?.importance);
				console.log('%cActions:', 'color: #aaa; font-weight: bold', data.response?.actions);
				console.groupEnd();
				break;

			case 'status':
				console.log(`[STATUS] ${message}`);
				break;

			case 'error':
				console.log(`[ERROR] ${message}`);
				addToGameLog('console_output', `[ERROR] ${message}`);
				break;
			
			case 'game_state':
				console.log('[GAME STATE] Received state update');
				if (data.state) {
					const nextRoom = data.state.current_room ?? null;
					const nextChapter = data.state.current_chapter ?? null;
					if (nextChapter !== currentGameState.currentChapter) {
						addToGameLog('chapter_change', nextChapter);
					}
					if (nextRoom !== currentGameState.currentRoom) {
						addToGameLog('scene_change', nextRoom);
					}
					currentGameState = {
						currentRoom: nextRoom,
						currentChapter: nextChapter
					};
				}
				break;

			case 'game_end':
				console.log('[GAME END] Game has ended');
				addToGameLog('console_output', '[GAME END]');
				sendEndToParent();
				break;

			case 'wait': {
				const seconds = data.seconds || 1;
				console.log(`[WAIT] ${seconds}s`);
				await wait(seconds * 1000)
				break;
			}

			case 'narrate': {
				if (!message) break;
				console.log(`[NARRATE] ${message}`);
				addToGameLog('console_output', message);
				// Only convert \n to <br> for plain text (not HTML content)
				const isHtml = message.trim().startsWith('<');
				const content = isHtml ? message : message.replace(/\n/g, '<br>');
				const html = `<span style="color: white;">${content}</span>`;
				term.echo(html, {raw: true, keepWords: true});
				term.echo('')
				break;
			}

			case 'say_error': {
				console.log(`[SAY ERROR] ${message}`);
				addToGameLog('console_output', `[ERROR] ${message}`);
				const html = `<span style="color: red;">${message}\n\n</span>`;
				term.echo(html, {raw: true, keepWords: true});
				term.echo('')
				break;
			}

			case 'room_image': {
				// Support both old format (image_path) and new format (room_image_url)
				const imageUrl = message?.room_image_url || message?.image_path || message;
				console.log(`[ROOM IMAGE]: ${imageUrl}`);
				if (imageUrl) {
					// Wait for image to load before continuing (allows fade_in to happen after)
					await new Promise((resolve) => {
						const img = new Image();
						img.onload = () => {
							console.log(`[ROOM IMAGE]: Loaded successfully`);
							updateRoomImage(imageUrl);
							resolve();
						};
						img.onerror = () => {
							console.log(`[ROOM IMAGE]: Failed to load`);
							updateRoomImage(imageUrl); // Still try to display
							resolve();
						};
						img.src = imageUrl;
					});
				} else {
					updateRoomImage(imageUrl);
				}
				break;
			}

			case 'fade_out': {
				const duration = data.seconds || 0.8;
				console.log(`[FADE OUT] ${duration}s`);
				const overlay = $('#figure .scene-fade-overlay');
				if (overlay.length) {
					overlay.css('transition', `opacity ${duration}s ease-in-out`);
					overlay.addClass('active');
					await wait(duration * 1000)
				}
				break;
			}

			case 'fade_in': {
				const duration = data.seconds || 0.8;
				console.log(`[FADE IN] ${duration}s`);
				const overlay = $('#figure .scene-fade-overlay');
				if (overlay.length) {
					overlay.css('transition', `opacity ${duration}s ease-in-out`);
					overlay.removeClass('active');
				}
				break;
			}

			case 'terminal_pause': {
				console.log('[TERMINAL PAUSE]');
				term.pause();
				break;
			}

			case 'terminal_resume': {
				console.log('[TERMINAL RESUME]');
				term.resume();
				break;
			}

			case 'freeze_terminal': {
				console.log('[FREEZE TERMINAL]');
				term.freeze(true);
				break;
			}

			case 'unfreeze_terminal': {
				console.log('[UNFREEZE TERMINAL]');
				term.freeze(false);
				break;
			}

			case 'terminal_clear': {
				console.log('[CONSOLE CLEAR]');
				term.clear();
				break;
			}

			case 'say_stream_start': {
				console.log(`[SAY STREAM START] ${message.prefix || ''}`);
				streamLogBuffer = message?.prefix || '';
				streamingController.handleStart(message);
				break;
			}

			case 'say_stream_word': {
				streamLogBuffer += message || '';
				streamingController.handleWord(message);
				break;
			}

			case 'say_stream_end': {
				await streamingController.handleEnd();
				if (streamLogBuffer.trim()) {
					addToGameLog('console_output', streamLogBuffer);
				}
				streamLogBuffer = '';
				break;
			}

			case 'npc_reply': {
				const npcTitle = data.npc_title || data.npc_name || 'NPC';
				console.log(`[NPC REPLY] ${npcTitle}: ${message}`);
				addToGameLog('console_output', `[${npcTitle}] ${message}`);
				const html = `<span style="color: white;"><b>[${npcTitle}]</b> ${message}</span>`;
				term.echo(html, {raw: true, keepWords: true});
				term.echo('');
				break;
			}

			default:
				console.log(`[UNKNOWN TYPE]: ${message}`);
				break;
		}
	}

	isProcessingQueue = false;
}

// ROOM IMAGE HANDLING
function updateRoomImage(imageUrl) {
	const figureDiv = $('#figure');
	
	if (!imageUrl) {
		figureDiv.html('');
		console.log(`[INFO] Cleared room image`);
		return;
	}

	// Use the URL directly - it's now a cloud URL from room_image_url
	const existingContainer = figureDiv.find('.scene-container');
	
	if (existingContainer.length > 0) {
		// Update existing image source to prevent layout shift/scrolling
		existingContainer.find('.scene-image').attr('src', imageUrl);
		console.log(`[INFO] Updated room image to: ${imageUrl}`);
	} else {
		figureDiv.html(`
			<div class="scene-container">
				<img src="${imageUrl}" alt="Room image" class="scene-image">
				<img src="images/frame.png" alt="Frame" class="frame-overlay">
				<div class="scene-fade-overlay"></div>
			</div>
		`);
		
		// Handle image load errors - hide figure if image not found
		figureDiv.find('.scene-image').on('error', function() {
			figureDiv.html('');
			console.log('[INFO] Image not found, hiding figure');
		});
		
		// Handle frame load errors - hide figure if frame not found
		figureDiv.find('.frame-overlay').on('error', function() {
			figureDiv.html('');
			console.log('[INFO] Frame not found, hiding figure');
		});
		
		console.log(`[INFO] Created room image with: ${imageUrl}`);
	}
}
