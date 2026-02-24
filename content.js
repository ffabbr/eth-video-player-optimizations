(function () {
    'use strict';

    var EXTRA_RATES = [2.5, 3];

    // -------------------------------------------------------------------------
    // Toolbar label
    // -------------------------------------------------------------------------

    function updateToolbarLabel(label) {
        var speedBtn = document.querySelector('button[name="es.upv.paella.playbackRateButton"]');
        if (!speedBtn) return;
        var span = speedBtn.querySelector('span.button-title');
        if (span) span.textContent = label;
    }

    // -------------------------------------------------------------------------
    // Buffer management
    //
    // Chrome does NOT scale its internal buffer target with playbackRate — the
    // buffer window is fixed in wall-clock time (~30-60 s), so at 3x speed you
    // exhaust it 3x faster. fetch() pre-fetching does NOT help because fetch
    // and <video> use separate caches.
    //
    // The only reliable content-script technique is:
    //   1. Seek-ahead trick: briefly seek past the current buffer end so Chrome
    //      issues a new HTTP range request for data beyond it, then seek back.
    //   2. Skip-to-next-buffered-range: when the video actually stalls, skip
    //      past the gap to the next already-buffered region instead of waiting.
    // -------------------------------------------------------------------------

    function getBufferedAhead(video) {
        var t = video.currentTime;
        var max = 0;
        for (var i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= t + 1) {
                max = Math.max(max, video.buffered.end(i) - t);
            }
        }
        return max;
    }

    function getBufferedEnd(video) {
        var t = video.currentTime;
        for (var i = video.buffered.length - 1; i >= 0; i--) {
            if (video.buffered.start(i) <= t + 1) {
                return video.buffered.end(i);
            }
        }
        return t;
    }

    var bufferManager = null;

    function stopBufferManager() {
        if (bufferManager) {
            bufferManager.stop();
            bufferManager = null;
        }
    }

    function startBufferManager(video, rate) {
        stopBufferManager();

        // Ensure the browser hint is as aggressive as possible
        video.preload = 'auto';

        if (rate < 2) return;

        var stopped      = false;
        var seekPending  = false;
        var lastTrigger  = 0;
        var COOLDOWN_MS  = 12000; // minimum gap between seek-ahead attempts
        var LOW_WATER    = 25;    // seconds ahead — trigger proactive seek below this
        var SEEK_PAST    = 3;     // seek this many seconds past buffer end

        // Diagnostic: log buffer state to the console so you can verify
        // whether Chrome is keeping up.
        function logState() {
            var ahead  = getBufferedAhead(video);
            var states = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
            console.log(
                '[PaellaSpeed] buffered ahead: ' + ahead.toFixed(1) + 's' +
                ' | network: ' + (states[video.networkState] || video.networkState) +
                ' | rate: ' + rate + 'x'
            );
            return ahead;
        }

        // Seek just past the current buffer end, then snap back.
        // This causes Chrome to issue a new HTTP range request for content
        // beyond where it stopped downloading.
        function seekAheadTrick() {
            if (seekPending || stopped) return;
            var now = Date.now();
            if (now - lastTrigger < COOLDOWN_MS) return;
            lastTrigger = now;
            seekPending = true;

            var savedTime   = video.currentTime;
            var bufferedEnd = getBufferedEnd(video);
            var target      = bufferedEnd + SEEK_PAST;

            if (target >= video.duration - 1) {
                seekPending = false;
                return;
            }

            console.log('[PaellaSpeed] seek-ahead trick: jumping to ' + target.toFixed(1) + 's then back');

            var wasPlaying = !video.paused;
            if (wasPlaying) video.pause();

            video.currentTime = target;

            // Give Chrome ~250 ms to register the position and issue the range
            // request, then snap back to where we were.
            setTimeout(function () {
                if (stopped) return;
                video.currentTime = savedTime;
                setTimeout(function () {
                    if (!stopped && wasPlaying) video.play();
                    seekPending = false;
                }, 150);
            }, 250);
        }

        // Poll every 5 s. If buffer is running low AND Chrome is idle (not
        // actively downloading), force a new range request via the seek trick.
        var intervalId = setInterval(function () {
            if (stopped || video.paused || video.ended) return;
            var ahead = logState();
            if (ahead < LOW_WATER && video.networkState !== 2 /* NETWORK_LOADING */) {
                seekAheadTrick();
            }
        }, 5000);

        // When the video actually stalls: skip past the buffering gap to the
        // nearest already-buffered segment so playback resumes immediately.
        // This trades a tiny content skip for uninterrupted playback.
        function onWaiting() {
            if (stopped) return;
            console.log('[PaellaSpeed] video stalled at ' + video.currentTime.toFixed(1) + 's');

            var t = video.currentTime;
            for (var i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) > t + 0.2) {
                    console.log('[PaellaSpeed] skipping gap → resuming at ' + video.buffered.start(i).toFixed(1) + 's');
                    video.currentTime = video.buffered.start(i);
                    return;
                }
            }

            // No pre-buffered segment exists ahead — try forcing one
            seekAheadTrick();
        }

        video.addEventListener('waiting', onWaiting);

        // Log initial state after a short delay to give the player time to start
        setTimeout(function () { if (!stopped) logState(); }, 1500);

        bufferManager = {
            stop: function () {
                stopped = true;
                clearInterval(intervalId);
                video.removeEventListener('waiting', onWaiting);
            }
        };
    }

    // -------------------------------------------------------------------------
    // Apply playback rate + start buffer manager on all videos
    // -------------------------------------------------------------------------

    function applyRate(rate) {
        var videos = document.querySelectorAll('video');
        videos.forEach(function (v) { v.playbackRate = rate; });
        // Manage buffering for the primary (first) video element
        if (videos.length) startBufferManager(videos[0], rate);
    }

    // -------------------------------------------------------------------------
    // Speed menu injection
    // -------------------------------------------------------------------------

    function isSpeedMenu(menuList) {
        var buttons = menuList.querySelectorAll('li.menu-button-item button');
        for (var i = 0; i < buttons.length; i++) {
            if (/^\d+(\.\d+)?x$/.test(buttons[i].getAttribute('aria-label') || '')) {
                return true;
            }
        }
        return false;
    }

    function menuHasRate(menuList, rate) {
        var buttons = menuList.querySelectorAll('li.menu-button-item button');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('aria-label') === rate + 'x') return true;
        }
        return false;
    }

    function injectRateButton(menuList, rate) {
        if (menuHasRate(menuList, rate)) return;

        var items = menuList.querySelectorAll('li.menu-button-item');
        if (!items.length) return;

        var label   = rate + 'x';
        var newItem = items[items.length - 1].cloneNode(true);
        var newBtn  = newItem.querySelector('button');
        if (!newBtn) return;

        newBtn.setAttribute('aria-label', label);
        newBtn.setAttribute('title', label);
        newBtn.classList.remove('selected');

        var span = newBtn.querySelector('span.menu-title');
        if (span) span.textContent = label;
        else newBtn.textContent = label;

        newBtn._itemData = { id: rate, title: label, selected: false };

        newBtn.addEventListener('click', function () {
            applyRate(rate);

            menuList.querySelectorAll('li.menu-button-item button').forEach(function (btn) {
                btn.classList.remove('selected');
                if (btn._itemData) btn._itemData.selected = false;
            });
            newBtn.classList.add('selected');
            newBtn._itemData.selected = true;

            updateToolbarLabel(label);
        });

        menuList.appendChild(newItem);
    }

    function processMenuList(menuList) {
        if (!isSpeedMenu(menuList)) return;
        EXTRA_RATES.forEach(function (rate) { injectRateButton(menuList, rate); });
    }

    // -------------------------------------------------------------------------
    // Keep toolbar label in sync for native Paella speed changes too,
    // and manage the buffer when the rate changes by any means.
    // -------------------------------------------------------------------------

    function watchVideoRateChanges() {
        function attach(video) {
            if (video._speedPatchListener) return;
            video._speedPatchListener = true;
            video.addEventListener('ratechange', function () {
                var r = video.playbackRate;
                updateToolbarLabel(r + 'x');
                startBufferManager(video, r);
            });
        }

        document.querySelectorAll('video').forEach(attach);

        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.tagName === 'VIDEO') attach(node);
                    else if (node.querySelectorAll) node.querySelectorAll('video').forEach(attach);
                });
            });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // -------------------------------------------------------------------------
    // Watch for speed popup menu appearing in the DOM
    // -------------------------------------------------------------------------

    function startMenuObserver() {
        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                m.addedNodes.forEach(function (node) {
                    if (node.nodeType !== 1) return;
                    if (node.classList && node.classList.contains('menu-button-content')) {
                        processMenuList(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('ul.menu-button-content').forEach(processMenuList);
                    }
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function init() {
        document.querySelectorAll('ul.menu-button-content').forEach(processMenuList);
        startMenuObserver();
        watchVideoRateChanges();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
