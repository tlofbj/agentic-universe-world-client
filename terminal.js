const SOCKET_URL = 'wss://agentic-universe-server.onrender.com/ws'
const BACKEND_URL = 'https://agentic-universe-server.onrender.com'

let streamingController
let messageQueue = []
let isProcessingQueue = false

// TERMINAL
let term = $('#terminal').terminal(interpreter, {
	name: 'Reason OS',
	greetings: 'Loading...',
	prompt: '\n>',
	clear: false,
	convertLinks: false,
	onInit: connectSocket,
}).click()

streamingController = createStreamingController(term, setupGlossaryTooltips)


// INTERPRETER
function interpreter(command, term) {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		console.log('[INFO] Message received but WebSocket is not open, reconnecting...')
		connectSocket()
		return
	}
	trimmed = command.trim()
	if (trimmed === '') return
	
	// Clear previous echo if command ≤ 3 chars
	if (trimmed.length <= 3 && !trimmed.startsWith('/') && !['yes', 'no', 'ok', 'idk', 'y', 'n', '?'].includes(trimmed.toLowerCase())) {
		const output = term.find('.terminal-output')
		const lines = output.children('div')
		if (lines.length > 0) {
			$(lines[lines.length - 1]).remove()
		}
		return
	}
	
	socket.send(JSON.stringify({
		type: 'player_input',
		message: trimmed
	}))
	term.echo('')
}

function start() {
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify({
			type: 'start',
			message: { state: localStorage.getItem('reason-os-game-state') }
		}))
	} else {
		console.log('[INFO] Socket not ready, will start when connected');
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
		console.clear();
		console.log('[INFO] WebSocket connected');
		if (term) {
			term.clear();
		}
		start();
	};

	socket.onclose = () => {
		console.log('[INFO] WebSocket connection lost');
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
			case 'status':
				console.log(`[STATUS] ${message}`);
				break;

			case 'error':
				console.log(`[ERROR] ${message}`);
				break;

			case 'wait': {
				const seconds = data.seconds || 1;
				console.log(`[WAIT] ${seconds}s`);
				await new Promise(resolve => setTimeout(resolve, seconds * 1000));
				break;
			}

			case 'narrate': {
				console.log(`[NARRATE] ${message}`);
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
				const html = `<span style="color: red;">${message}\n\n</span>`;
				term.echo(html, {raw: true, keepWords: true});
				term.echo('')
				break;
			}

			case 'room_image':
				const imagePath = message?.image_path || message;
				console.log(`[ROOM IMAGE]: ${imagePath}`);
				updateRoomImage(imagePath);
				break;

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
					await new Promise(resolve => setTimeout(resolve, duration * 1000));
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
				streamingController.handleEnd();
				break;
			}

			case 'npc_reply': {
				const npcTitle = data.npc_title || data.npc_name || 'NPC';
				console.log(`[NPC REPLY] ${npcTitle}: ${message}`);
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
function updateRoomImage(imagePath) {
	const figureDiv = $('#figure');
	
	if (!imagePath) {
		figureDiv.html('');
		console.log(`[INFO] Cleared room image`);
		return;
	}

	// Fetch image from backend
	const fullImageUrl = `${BACKEND_URL}/${imagePath}`;
	const existingContainer = figureDiv.find('.scene-container');
	
	if (existingContainer.length > 0) {
		// Update existing image source to prevent layout shift/scrolling
		existingContainer.find('.scene-image').attr('src', fullImageUrl);
		console.log(`[INFO] Updated room image to: ${fullImageUrl}`);
	} else {
		figureDiv.html(`
			<div class="scene-container">
				<img src="${fullImageUrl}" alt="Room image" class="scene-image">
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
		
		console.log(`[INFO] Created room image with: ${fullImageUrl}`);
	}
}
