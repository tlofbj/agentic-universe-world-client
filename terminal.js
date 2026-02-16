const SOCKET_URL = 'wss://agentic-universe-server.onrender.com/ws'

let streamingController
let messageQueue = []
let isProcessingQueue = false
let worldData = null // Store world data received from parent
let socket = null
let currentSessionId = null
let reconnecting = false
let didResumeFallback = false

const DEV_FORCE_FRESH_GAME = (() => {
	const query = new URLSearchParams(window.location.search)
	if (query.has('fresh')) return query.get('fresh') !== '0'
	return ['localhost', '127.0.0.1'].includes(window.location.hostname)
})()

function sessionStorageKey() {
	const worldName = worldData?.name || 'default'
	return `reason-os-session-id:${worldName}`
}

function loadStoredSessionId() {
	if (DEV_FORCE_FRESH_GAME) return null
	return sessionStorage.getItem(sessionStorageKey())
}

function saveSessionId(sessionId) {
	currentSessionId = sessionId
	if (DEV_FORCE_FRESH_GAME) return
	sessionStorage.setItem(sessionStorageKey(), sessionId)
}

function clearSessionId() {
	currentSessionId = null
	sessionStorage.removeItem(sessionStorageKey())
}

function resetClientGameState() {
	gameLog = []
	currentGameState = {
		currentRoom: null,
		currentChapter: null,
		playerInventory: [],
		playerFlags: []
	}
	sendGameLogToParent()
}

// Game log for parent iframe communication
let gameLog = []
let currentGameState = {
	currentRoom: null,
	currentChapter: null,
	playerInventory: [],
	playerFlags: []
}

// Add entry to game log
function addToGameLog(type, data) {
	gameLog.push({
		timestamp: new Date().toISOString(),
		type: type,
		data: data
	})
}

// Send game log to parent iframe
function sendGameLogToParent() {
	window.parent.postMessage({
		type: 'GAME_LOG',
		log: {
			...currentGameState,
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

streamingController = createStreamingController(term, setupGlossaryTooltips)

// Listen for messages from parent window (iframe communication)
window.addEventListener('message', (event) => {
	// Optionally validate event.origin for security
	// if (event.origin !== 'https://your-platform.com') return

	if (event.data.type === 'INIT_GAME') {
		console.log('[INFO] Received INIT_GAME from parent')
		worldData = event.data.world
		if (DEV_FORCE_FRESH_GAME) {
			clearSessionId()
		}
		
		// If socket is already connected, start the game
		if (socket && socket.readyState === WebSocket.OPEN) {
			startWithWorld()
		}
		// Otherwise, the game will start when socket connects
	}
})

// INTERPRETER
function interpreter(command, term) {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
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
	
	socket.send(JSON.stringify({
		type: 'player_input',
		message: trimmed
	}))
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
	socket.send(JSON.stringify({
		type: 'start',
		message: {
			world: worldData
		}
	}))
}

function startWithWorld() {
	if (!worldData) {
		console.log('[ERROR] No world data available')
		showWorldDataError()
		return
	}
	
	if (socket && socket.readyState === WebSocket.OPEN) {
		const storedSessionId = currentSessionId || loadStoredSessionId()
		if (!DEV_FORCE_FRESH_GAME && storedSessionId) {
			console.log(`[INFO] Attempting to resume session ${storedSessionId}`)
			socket.send(JSON.stringify({
				type: 'resume',
				message: {
					session_id: storedSessionId
				}
			}))
			return
		}
		console.log('[INFO] Starting fresh game with world data')
		socket.send(JSON.stringify({
			type: 'start',
			message: {
				world: worldData
			}
		}))
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
		reconnecting = true
		connectSocket();
	};

	socket.onerror = () => {
		console.log('[ERROR] WebSocket error');
	};

	return socket;
}

async function processMessageQueue() {
	if (isProcessingQueue) return;
	isProcessingQueue = true;

	while (messageQueue.length > 0) {
		const data = messageQueue.shift();
		const message = data.message;

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
				if (!didResumeFallback && socket && socket.readyState === WebSocket.OPEN) {
					didResumeFallback = true
					console.log('[SESSION] Falling back to fresh start')
					socket.send(JSON.stringify({
						type: 'start',
						message: {
							world: worldData
						}
					}))
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
				// Update current game state from backend
				console.log('[GAME STATE] Received state update');
				if (data.state) {
					currentGameState = {
						currentRoom: data.state.current_room || currentGameState.currentRoom,
						currentChapter: data.state.current_chapter || currentGameState.currentChapter,
						playerInventory: data.state.inventory || currentGameState.playerInventory,
						playerFlags: data.state.flags || currentGameState.playerFlags
					};
					sendGameLogToParent();
				}
				break;

			case 'game_end':
				console.log('[GAME END] Game has ended');
				addToGameLog('console_output', '[GAME END]');
				sendGameLogToParent();
				sendEndToParent();
				break;

			case 'wait': {
				const seconds = data.seconds || 1;
				console.log(`[WAIT] ${seconds}s`);
				await new Promise(resolve => setTimeout(resolve, seconds * 1000));
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
					await new Promise(resolve => setTimeout(resolve, duration * 1000));
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
				streamingController.handleStart(message);
				break;
			}

			case 'say_stream_word': {
				streamingController.handleWord(message);
				break;
			}

			case 'say_stream_end': {
				await streamingController.handleEnd();
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

// GLOSSARY TOOLTIP HANDLING
function setupGlossaryTooltips() {
	// Remove existing tooltip handlers to avoid duplicates
	$(document).off('mouseenter mouseleave', '.glossary-word');
	$(document).off('mousemove.glossary');
	
	// Setup tooltip that follows mouse cursor and preserves existing styles
	$(document).on('mouseenter', '.glossary-word', function(e) {
		const definition = $(this).attr('data-definition');
		if (!definition) return;
		
		const wordElement = this;
		const computedStyle = window.getComputedStyle(wordElement);
		
		const tooltip = $('<div class="glossary-tooltip"></div>')
			.text(definition)
			.css({
				// color: computedStyle.color,
				fontFamily: computedStyle.fontFamily,
				// fontSize: computedStyle.fontSize,
				// lineHeight: computedStyle.lineHeight,
				// display: 'none'
			})
			.appendTo('body');
		
		// Position tooltip at mouse cursor with offset
		const updatePosition = (event) => {
			const offsetX = 10;
			const offsetY = +10;
			let left = event.pageX + offsetX;
			let top = event.pageY + offsetY;
			
			// Keep tooltip within viewport
			const tooltipWidth = tooltip.outerWidth();
			const tooltipHeight = tooltip.outerHeight();
			const viewportWidth = $(window).width();
			const viewportHeight = $(window).height();
			
			if (left + tooltipWidth > viewportWidth - 10) {
				left = event.pageX - tooltipWidth - offsetX;
			}
			if (top + tooltipHeight > viewportHeight - 10) {
				top = event.pageY - tooltipHeight - offsetY;
			}
			if (left < 10) left = 10;
			if (top < 10) top = 10;
			
			tooltip.css({ left: left + 'px', top: top + 'px' }).show();
		};
		
		// Update position on mouse move
		$(document).on('mousemove.glossary', updatePosition);
		updatePosition(e);
		
		// Store reference for cleanup
		$(this).data('tooltip', tooltip);
	});
	
	$(document).on('mouseleave', '.glossary-word', function() {
		const tooltip = $(this).data('tooltip');
		if (tooltip) {
			tooltip.remove();
			$(this).removeData('tooltip');
		}
		$(document).off('mousemove.glossary');
	});
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
