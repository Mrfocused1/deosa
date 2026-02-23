/* ── De'Osa Voice Assistant · ElevenLabs Conversational AI ── *
 *                                                              *
 *  Set window.VOICE_AGENT_ID before this script loads to      *
 *  provide a page-specific agent ID.                           *
 *                                                              *
 *  Set window.VOICE_CLIENT_TOOLS before this script loads to  *
 *  provide page-specific client tools (e.g. cart actions).    *
 * ──────────────────────────────────────────────────────────── */

(function () {

    const AGENT_ID = window.VOICE_AGENT_ID || 'agent_2901kj45e7cnfszrrjfhfj4qdc8j';

    let _conv   = null;
    let _active = false;

    /* ── Inject one-time CSS for the connecting spin state ── */
    const _style = document.createElement('style');
    _style.textContent = `
        @keyframes voice-connecting-spin {
            0%   { transform: rotate(0deg);   }
            100% { transform: rotate(360deg); }
        }
        #ai-voice-btn.voice-connecting {
            animation: voice-connecting-spin 1.2s linear infinite,
                       none !important; /* override pulse-glow when connecting */
        }
        #ai-voice-btn.voice-error {
            border-color: rgba(239,68,68,0.85) !important;
            box-shadow: 0 0 14px 4px rgba(239,68,68,0.35) !important;
        }
    `;
    document.head.appendChild(_style);

    /* ── UI state machine ── */
    function setVoiceUI(state) {
        const btn      = document.getElementById('ai-voice-btn');
        const idleIcon = document.getElementById('ai-idle-icon');
        const liveIcon = document.getElementById('ai-live-icon');
        if (!btn) return;

        /* Reset all dynamic classes / styles */
        btn.classList.remove('ai-live-glow', 'voice-connecting', 'voice-error');
        btn.style.opacity = '1';

        /* Show idle phone icon by default */
        if (idleIcon) idleIcon.classList.remove('hidden');
        if (liveIcon) { liveIcon.classList.add('hidden'); liveIcon.classList.remove('flex'); }

        switch (state) {
            case 'connecting':
                btn.style.opacity = '0.6';
                btn.classList.add('voice-connecting');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'listening':
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'speaking':
                btn.classList.add('ai-live-glow');
                if (idleIcon) idleIcon.classList.add('hidden');
                if (liveIcon) { liveIcon.classList.remove('hidden'); liveIcon.classList.add('flex'); }
                break;

            case 'error':
                btn.classList.add('voice-error');
                break;

            default: /* idle */
                break;
        }
    }

    /* ── Start a session ──
     *  firstMessage (optional): overrides the agent's opening line,
     *  used when auto-reconnecting after a page navigation.
     */
    async function voiceStart(firstMessage) {
        setVoiceUI('connecting');
        try {
            const { Conversation } = await import(
                'https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm'
            );

            /* Merge page-specific tools with universal tools */
            const pageTools = window.VOICE_CLIENT_TOOLS || {};

            /* get_current_time — returns UK time + greeting word */
            if (!pageTools.get_current_time) {
                pageTools.get_current_time = function () {
                    var now    = new Date();
                    var ukTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
                    var hour   = ukTime.getHours();
                    var mins   = String(ukTime.getMinutes()).padStart(2, '0');
                    var greeting =
                        hour >= 5  && hour < 12 ? 'Good morning' :
                        hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
                    return JSON.stringify({ time: hour + ':' + mins, greeting: greeting });
                };
            }

            /* navigate_to_menu — soft-nav with auto-reconnect on arrival */
            if (!pageTools.navigate_to_menu) {
                pageTools.navigate_to_menu = function () {
                    var onMenu = window.location.pathname.toLowerCase().includes('catering');
                    if (onMenu) {
                        return "You're already on our menu page — feel free to browse!";
                    }
                    /* Flag the destination page to auto-reconnect */
                    sessionStorage.setItem('deosa_voice_return', '1');
                    /* Delay lets Mary finish her sentence before the page changes */
                    setTimeout(function () {
                        window.location.href = 'catering.html';
                    }, 2600);
                    return "I'm taking you to our menu page right now — I'll be right with you there.";
                };
            }

            /* Build session options */
            var sessionOpts = {
                agentId: AGENT_ID,
                clientTools: pageTools,

                onConnect: function () {
                    _active = true;
                    setVoiceUI('listening');
                },

                onDisconnect: function () {
                    if (_active) voiceStop();
                },

                onError: function (msg) {
                    console.error('[De\'Osa Voice]', msg);
                    _conv   = null;
                    _active = false;
                    setVoiceUI('error');
                    setTimeout(function () { setVoiceUI('idle'); }, 3000);
                },

                onModeChange: function (d) {
                    if (!_active) return;
                    setVoiceUI(d.mode === 'speaking' ? 'speaking' : 'listening');
                }
            };

            /* Override opening line when returning from another page */
            if (firstMessage) {
                sessionOpts.overrides = {
                    agent: { firstMessage: firstMessage }
                };
            }

            _conv = await Conversation.startSession(sessionOpts);

        } catch (err) {
            console.error('[De\'Osa Voice] Failed to start session:', err);
            _conv   = null;
            _active = false;
            setVoiceUI('error');
            setTimeout(function () { setVoiceUI('idle'); }, 3000);
        }
    }

    /* ── End a session ── */
    async function voiceStop() {
        _active = false;
        if (_conv) {
            try { await _conv.endSession(); } catch (_) { /* ignore */ }
            _conv = null;
        }
        setVoiceUI('idle');
    }

    /* ── Public toggle ── */
    window.toggleAIVoice = async function () {
        /* On non-catering pages, the button navigates to the menu and
           auto-starts the call on arrival instead of starting here */
        var onCatering = window.location.pathname.toLowerCase().includes('catering');
        if (!onCatering) {
            sessionStorage.setItem('deosa_voice_return', '1');
            window.location.href = 'catering.html';
            return;
        }

        if (_active) {
            voiceStop();
        } else {
            voiceStart();
        }
    };

    /* ── Auto-reconnect after page navigation ──────────────────────────
     *  If the user was mid-conversation and Mary navigated them here,
     *  automatically restart the session with a seamless handoff message.
     */
    if (sessionStorage.getItem('deosa_voice_return') === '1') {
        sessionStorage.removeItem('deosa_voice_return');
        setTimeout(function () {
            voiceStart(
                "I'm back! You're now on the De'Osa menu page. " +
                "Let's pick up where we left off — what would you like to add to your order?"
            );
        }, 700);
    }

})();
