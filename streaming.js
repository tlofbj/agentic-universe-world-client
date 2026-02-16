const createStreamingState = () => ({
	active: false,
	prefix: '',
	content: '',
	lineIndex: null,
	pendingWords: [],
	initializationPending: false,
	processingBuffered: false
})

function createStreamingController(term, options = {}) {
	const npcDelayMs = options.npcDelayMs ?? 1000
	const wordDelayMs = options.wordDelayMs ?? 50
	let state = createStreamingState()

	const resetState = () => {
		state = createStreamingState()
	}

	const ensureStreamingLine = () => {
		if (state.lineIndex !== null) return
		term.echo('', {raw: true})
		const output = term.find('.terminal-output')
		const lines = output.children('div')
		state.lineIndex = lines.length - 1
	}

	const updateStreamingLine = () => {
		if (state.lineIndex === null) return
		const fullContent = state.prefix + state.content
		const html = `<span style="color: white;">${fullContent}</span>`
		const output = term.find('.terminal-output')
		const lines = output.children('div')
		if (lines.length > 0 && lines[state.lineIndex]) {
			$(lines[state.lineIndex]).html(html)
		}
	}

	const flushPendingWords = () => {
		if (state.pendingWords.length > 0) {
			state.content += state.pendingWords.join('')
			state.pendingWords = []
		}
		state.processingBuffered = false
	}

	const beginStreaming = () => {
		state.active = true
		state.initializationPending = false
		ensureStreamingLine()
	}

	const startBufferedProcessing = () => {
		if (!state.pendingWords.length) {
			state.processingBuffered = false
			return
		}
		state.processingBuffered = true
		const processNextWord = () => {
			if (!state.pendingWords.length) {
				state.processingBuffered = false
				return
			}
			state.content += state.pendingWords.shift()
			updateStreamingLine()
			setTimeout(processNextWord, wordDelayMs)
		}
		processNextWord()
	}

	const finalizeStreaming = () => {
		return new Promise((resolve) => {
			if (!state.active && !state.initializationPending) {
				resetState()
				resolve()
				return
			}
			ensureStreamingLine()
			
			// Wait for all buffered words to be processed before flushing
			const waitForBufferedProcessing = () => {
				if (state.processingBuffered || state.pendingWords.length > 0) {
					// Still processing, check again in a bit
					setTimeout(waitForBufferedProcessing, wordDelayMs)
					return
				}
				// All words processed, now flush any remaining and finalize
				flushPendingWords()
				updateStreamingLine()
				term.echo('')  // Add line break after streaming ends (like narrate)
				resetState()
				resolve()
			}
			
			waitForBufferedProcessing()
		})
	}

	return {
		handleStart(message) {
			resetState()
			state.prefix = message?.prefix || ''
			const isNPC = state.prefix && state.prefix.trim() !== ''

			if (isNPC) {
				state.initializationPending = true
				setTimeout(() => {
					beginStreaming()
					startBufferedProcessing()
				}, npcDelayMs)
			} else {
				beginStreaming()
			}
		},

		handleWord(word) {
			if (state.active) {
				if (state.processingBuffered) {
					state.pendingWords.push(word)
				} else {
					state.content += word
					updateStreamingLine()
				}
			} else if (state.initializationPending) {
				state.pendingWords.push(word)
			}
		},

		handleEnd() {
			if (state.initializationPending) {
				return new Promise((resolve) => {
					const checkInterval = setInterval(() => {
						if (state.active && !state.initializationPending) {
							clearInterval(checkInterval)
							finalizeStreaming().then(resolve)
						}
					}, wordDelayMs)

					setTimeout(() => {
						clearInterval(checkInterval)
						if (state.initializationPending) {
							beginStreaming()
						}
						finalizeStreaming().then(resolve)
					}, npcDelayMs)
				})
			}

			if (state.active) {
				return finalizeStreaming()
			}

			return Promise.resolve()
		}
	}
}


