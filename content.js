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
    // Bookmark feature
    // -------------------------------------------------------------------------

    var BM_KEY = 'ethVideoBookmarks';

    function getBookmarks(cb) {
        chrome.storage.local.get(BM_KEY, function (res) {
            cb(res[BM_KEY] || []);
        });
    }

    function saveBookmarks(bookmarks) {
        var data = {};
        data[BM_KEY] = bookmarks;
        chrome.storage.local.set(data);
    }

    function isHomePage() {
        return window.location.pathname === '/';
    }

    function isLectureArchivePage() {
        // matches /lectures/{dept}/{year}/{semester}/{courseId} — exactly 5 non-empty segments
        var parts = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
        return parts.length === 5 && parts[0] === 'lectures';
    }

    function bookmarkSVG(filled) {
        var fill = filled ? 'currentColor' : 'none';
        return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"' +
            ' fill="' + fill + '" stroke="currentColor" stroke-width="2"' +
            ' stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>' +
            '</svg>';
    }

    // Add bookmark toggle button to a lecture archive page.
    // Returns true when the share button is found (DOM ready), false to retry.
    function setupLectureBookmark() {
        if (document.getElementById('ethvideo-bm-btn')) return true;

        var shareBtn = document.querySelector('button[aria-label="Serie teilen"]');
        if (!shareBtn) return false;

        var url = window.location.pathname;

        // Inject button immediately so the user sees it without waiting for storage
        var btn = document.createElement('button');
        btn.id        = 'ethvideo-bm-btn';
        btn.type      = 'button';
        btn.className = shareBtn.className;
        btn.setAttribute('aria-label', 'Lesezeichen hinzufügen');
        btn.title     = 'Lesezeichen hinzufügen';
        btn.innerHTML = bookmarkSVG(false);

        // Wrap in the same structure as the share button (.css-79elbk inside .css-1vtfuzk)
        var innerDiv = document.createElement('div');
        innerDiv.className = shareBtn.parentElement.className;
        innerDiv.appendChild(btn);
        shareBtn.parentElement.parentElement.appendChild(innerDiv);

        // Update state from storage
        getBookmarks(function (bms) {
            var marked = bms.some(function (b) { return b.url === url; });
            if (marked) {
                btn.innerHTML = bookmarkSVG(true);
                btn.style.color = 'inherit';
                btn.setAttribute('aria-label', 'Lesezeichen entfernen');
                btn.title = 'Lesezeichen entfernen';
            }
        });

        btn.addEventListener('click', function () {
            getBookmarks(function (bms) {
                var idx = -1;
                for (var i = 0; i < bms.length; i++) {
                    if (bms[i].url === url) { idx = i; break; }
                }
                var nowMarked;
                if (idx >= 0) {
                    bms.splice(idx, 1);
                    nowMarked = false;
                } else {
                    var h1 = document.querySelector('h1');
                    var title = h1 ? h1.textContent.trim() : url;
                    bms.push({ url: url, title: title, addedAt: Date.now() });
                    nowMarked = true;
                }
                saveBookmarks(bms);
                btn.innerHTML = bookmarkSVG(nowMarked);
                btn.style.color = nowMarked ? 'inherit' : '';
                btn.setAttribute('aria-label', nowMarked ? 'Lesezeichen entfernen' : 'Lesezeichen hinzufügen');
                btn.title = btn.getAttribute('aria-label');
            });
        });

        return true;
    }

    // Replace "Video of the week" on the homepage with the bookmarks list.
    // Returns true when the h2 element is found, false to retry.
    function setupHomepageBookmarks() {
        var targetH2 = null;
        var allH2 = document.querySelectorAll('h2');
        for (var i = 0; i < allH2.length; i++) {
            if (allH2[i].textContent.trim() === 'Video of the week') {
                targetH2 = allH2[i];
                break;
            }
        }
        if (!targetH2) return false; // DOM not ready yet, retry

        var h2Parent      = targetH2.parentElement;
        var mainContainer = h2Parent.parentElement;
        if (!mainContainer) return false;

        // Always re-hide — React may have re-rendered these elements and reset
        // any inline display:none we set during a previous navigation.
        h2Parent.style.display = 'none';
        if (h2Parent.nextElementSibling) {
            h2Parent.nextElementSibling.style.display = 'none';
        }

        // Bookmarks section already present in this DOM instance — done.
        if (document.getElementById('ethvideo-bm-section')) return true;

        // First time on this DOM: inject styles and build the section.
        injectBookmarkStyles();

        var section = document.createElement('div');
        section.id = 'ethvideo-bm-section';
        section.style.cssText = 'margin-bottom: 24px;';

        var heading = document.createElement('h2');
        heading.className   = targetH2.className;
        heading.textContent = 'Bookmarks';
        section.appendChild(heading);

        var contentArea = document.createElement('div');
        contentArea.id = 'ethvideo-bm-content';
        section.appendChild(contentArea);

        mainContainer.insertBefore(section, mainContainer.firstChild);

        getBookmarks(function (bms) {
            renderBookmarkList(contentArea, bms);
        });

        return true;
    }

    function injectSidebarHide() {
        if (document.getElementById('ethvideo-sidebar-hide')) return;
        var s = document.createElement('style');
        s.id = 'ethvideo-sidebar-hide';
        // The sidebar is always the first div inside <main>; hide it on all pages.
        s.textContent =
            'main > div:first-child { display: none !important; }' +
            'nav[aria-label="breadcrumbs"] { display: none !important; }' +
            '.css-aetk3e { display: none !important; }' +
            '.css-1bhbe8x { display: none !important; }';
        document.head.appendChild(s);
    }

    function injectBookmarkStyles() {
        if (document.getElementById('ethvideo-bm-styles')) return;
        var s = document.createElement('style');
        s.id = 'ethvideo-bm-styles';
        s.textContent =
            '.ethvideo-bm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-top:28px}' +
            '.ethvideo-bm-card{position:relative;background:#f3f3f3;border:none;overflow:hidden}' +
            '.ethvideo-bm-link{display:block;padding:22px 44px 22px 22px;text-decoration:none;color:inherit}' +
            '.ethvideo-bm-link:hover{text-decoration:none}' +
            '.ethvideo-bm-icon{line-height:0;margin-bottom:12px;color:inherit}' +
            '.ethvideo-bm-title{font-size:16px;font-weight:600;line-height:1.35}' +
            '.ethvideo-bm-arrow{display:flex;align-items:center;gap:3px;margin-top:14px;' +
                'font-size:12px;color:rgba(0,0,0,0.38);opacity:0;transition:opacity .15s}' +
            '@media(prefers-color-scheme:dark){.ethvideo-bm-card{background:#2d2d2d}.ethvideo-bm-arrow{color:rgba(255,255,255,0.35)}}' +
            '[data-color-scheme="dark"] .ethvideo-bm-card{background:#2d2d2d}' +
            '[data-color-scheme="dark"] .ethvideo-bm-arrow{color:rgba(255,255,255,0.35)}' +
            '[data-color-scheme="light"] .ethvideo-bm-card{background:#f3f3f3}' +
            '[data-color-scheme="light"] .ethvideo-bm-arrow{color:rgba(0,0,0,0.38)}' +
            '.ethvideo-bm-card:hover .ethvideo-bm-arrow{opacity:1}' +
            '.ethvideo-bm-remove{position:absolute;top:10px;right:10px;border:none;background:none;cursor:pointer;' +
                'padding:4px;line-height:0;border-radius:4px;color:rgba(0,0,0,0.28);' +
                'opacity:0;transition:opacity .15s,background .15s,color .15s}' +
            '@media(prefers-color-scheme:dark){.ethvideo-bm-remove{color:rgba(255,255,255,0.35)}}' +
            '[data-color-scheme="dark"] .ethvideo-bm-remove{color:rgba(255,255,255,0.35)}' +
            '[data-color-scheme="light"] .ethvideo-bm-remove{color:rgba(0,0,0,0.28)}' +
            '.ethvideo-bm-card:hover .ethvideo-bm-remove{opacity:1}' +
            '.ethvideo-bm-remove:hover{background:rgba(239,68,68,0.12)!important;color:#ef4444!important}' +
            '.ethvideo-bm-empty{margin-top:12px;font-size:14px;opacity:0.55}';
        document.head.appendChild(s);
    }

    function renderBookmarkList(container, bookmarks) {
        container.innerHTML = '';

        // Most recently bookmarked first
        var sorted = bookmarks.slice().sort(function (a, b) {
            return (b.addedAt || 0) - (a.addedAt || 0);
        });

        if (sorted.length === 0) {
            var empty = document.createElement('p');
            empty.className = 'ethvideo-bm-empty';
            empty.textContent = 'Noch keine Lesezeichen. Besuche eine Vorlesungsseite, um Lesezeichen hinzuzufügen.';
            container.appendChild(empty);
            return;
        }

        var grid = document.createElement('div');
        grid.className = 'ethvideo-bm-grid';

        sorted.forEach(function (bm) {
            var bmUrl = bm.url;

            var card = document.createElement('div');
            card.className = 'ethvideo-bm-card';

            var link = document.createElement('a');
            link.className = 'ethvideo-bm-link';
            link.href = bmUrl;

            var icon = document.createElement('div');
            icon.className = 'ethvideo-bm-icon';
            icon.innerHTML = bookmarkSVG(true);

            var title = document.createElement('div');
            title.className = 'ethvideo-bm-title';
            title.textContent = bm.title;

            var arrow = document.createElement('div');
            arrow.className = 'ethvideo-bm-arrow';
            arrow.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none"' +
                ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="m9 18 6-6-6-6"/></svg>Zur Vorlesung';

            link.appendChild(icon);
            link.appendChild(title);
            link.appendChild(arrow);

            var removeBtn = document.createElement('button');
            removeBtn.className = 'ethvideo-bm-remove';
            removeBtn.type = 'button';
            removeBtn.title = 'Lesezeichen entfernen';
            removeBtn.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"' +
                ' stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
                '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            removeBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                getBookmarks(function (bms) {
                    var filtered = [];
                    for (var j = 0; j < bms.length; j++) {
                        if (bms[j].url !== bmUrl) filtered.push(bms[j]);
                    }
                    saveBookmarks(filtered);
                    var area = document.getElementById('ethvideo-bm-content');
                    if (area) renderBookmarkList(area, filtered);
                });
            });

            card.appendChild(link);
            card.appendChild(removeBtn);
            grid.appendChild(card);
        });

        container.appendChild(grid);
    }

    // Run the appropriate bookmark setup for the current URL, retrying until
    // the required DOM element appears (React may not have rendered yet).
    function runCurrentPage() {
        var MAX_ATTEMPTS = 20;
        var attempts = 0;

        function attempt() {
            var done = true;
            if (isHomePage()) {
                done = setupHomepageBookmarks();
            } else if (isLectureArchivePage()) {
                done = setupLectureBookmark();
            }
            if (!done && ++attempts < MAX_ATTEMPTS) {
                setTimeout(attempt, 250);
            }
        }

        attempt();
    }

    // Intercept SPA navigation so bookmark UI is injected after React re-renders.
    function patchHistory() {
        var origPush    = history.pushState.bind(history);
        var origReplace = history.replaceState.bind(history);

        history.pushState = function () {
            origPush.apply(history, arguments);
            setTimeout(runCurrentPage, 200);
        };
        history.replaceState = function () {
            origReplace.apply(history, arguments);
            setTimeout(runCurrentPage, 200);
        };
        window.addEventListener('popstate', function () {
            setTimeout(runCurrentPage, 200);
        });

        // Fallback: some React Router versions update the URL without going
        // through pushState (e.g. same-route navigation). Watch for any URL
        // change by piggybacking on DOM mutations.
        var lastUrl = location.href;
        new MutationObserver(function () {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(runCurrentPage, 200);
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function init() {
        document.querySelectorAll('ul.menu-button-content').forEach(processMenuList);
        startMenuObserver();
        watchVideoRateChanges();
        injectSidebarHide();
        patchHistory();
        runCurrentPage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
