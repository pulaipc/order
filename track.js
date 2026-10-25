    const supabaseClient = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);

    const $ = id => document.getElementById(id);
    let currentPhone = null;
    let currentOrders = [];
    let currentOrder = null;
    let currentOrderId = null;
    // Set only when the page was opened from a private link. A phone lookup can
    // never set it, because orders_by_phone does not return tokens.
    let currentToken = null;

    const RATE_LIMIT = {
        maxAttempts: 5,
        windowMs: 10 * 60 * 1000,
        cooldownMs: 60 * 1000,
        storageKey: 'trackRateLimit'
    };

    function getRateState() {
        try {
            const raw = localStorage.getItem(RATE_LIMIT.storageKey);
            if (!raw) return { fails: [], lockedUntil: 0 };
            const parsed = JSON.parse(raw);
            return { fails: Array.isArray(parsed.fails) ? parsed.fails : [], lockedUntil: parsed.lockedUntil || 0 };
        } catch { return { fails: [], lockedUntil: 0 }; }
    }
    function saveRateState(state) {
        try { localStorage.setItem(RATE_LIMIT.storageKey, JSON.stringify(state)); } catch {}
    }
    function pruneOldFails(fails) {
        const cutoff = Date.now() - RATE_LIMIT.windowMs;
        return fails.filter(t => t > cutoff);
    }
    function checkRateLimit() {
        const state = getRateState();
        const now = Date.now();
        if (state.lockedUntil > now) return { allowed: false, remainingMs: state.lockedUntil - now };
        state.fails = pruneOldFails(state.fails);
        if (state.fails.length >= RATE_LIMIT.maxAttempts) {
            state.lockedUntil = now + RATE_LIMIT.cooldownMs;
            saveRateState(state);
            return { allowed: false, remainingMs: RATE_LIMIT.cooldownMs };
        }
        saveRateState(state);
        return { allowed: true, remainingMs: 0 };
    }
    function recordFailure() {
        const state = getRateState();
        state.fails = pruneOldFails(state.fails);
        state.fails.push(Date.now());
        if (state.fails.length >= RATE_LIMIT.maxAttempts) state.lockedUntil = Date.now() + RATE_LIMIT.cooldownMs;
        saveRateState(state);
    }
    function recordSuccess() { saveRateState({ fails: [], lockedUntil: 0 }); }

    function applyRateLimitUI() {
        const btn = $('trackBtn');
        const input = $('trackPhoneInput');
        if (!btn) return false;
        const result = checkRateLimit();
        if (result.allowed) { btn.disabled = false; input.disabled = false; return false; }
        btn.disabled = true;
        input.disabled = true;
        const totalSec = Math.ceil(result.remainingMs / 1000);
        let remaining = totalSec;
        const tick = () => {
            if (remaining <= 0) { btn.disabled = false; input.disabled = false; setStatus(''); return; }
            setStatus(`Too many attempts. Please wait ${remaining}s before trying again.`, '#e57373', 0);
            remaining--;
            setTimeout(tick, 1000);
        };
        tick();
        return true;
    }

    // Emoji stage icons
    const STAGE_ICONS = {
        'Order Received':   '\u{1F4E5}',  // 📥
        'Confirmed':        '\u{1F4DD}',  // 📝
        'In Progress':      '\u{1F527}',  // 🔧
        'Ready':            '\u{1F4E6}',  // 📦
        'Completed':        '\u2705',     // ✅
        'Cancelled':        '\u274C'      // ❌
    };

    // Courier lookup
    const COURIERS = {
        'jnt':       { label: 'J&T Express',   pattern: 'https://www.jtexpress.my/tracking/{n}' },
        'poslaju':   { label: 'Pos Laju',      pattern: 'https://tracking.pos.com.my/tracking?trackingNumber={n}' },
        'gdex':      { label: 'GDEX',          pattern: 'https://www.gdexpress.com/malaysia/e-tracking/?tracking_no={n}' },
        'citylink':  { label: 'City-Link',     pattern: 'https://www.citylinkexpress.com/track/?tracking_no={n}' },
        'dhl':       { label: 'DHL eCommerce', pattern: 'https://www.dhl.com/my-en/home/tracking.html?tracking-id={n}' },
        'ninjavan':  { label: 'Ninja Van',     pattern: 'https://www.ninjavan.co/en-my/tracking?id={n}' },
        'other':     { label: 'Courier',       pattern: '' }
    };

    const INACTIVE_STATUSES = ['Completed', 'Cancelled'];
    function isActiveOrder(order) {
        const status = order.status || 'Pending';
        return INACTIVE_STATUSES.indexOf(status) === -1;
    }

    function setHeaderOrderPageLink(href) {
        const link = $('headerOrderPageLink');
        if (link) link.href = href || 'index.html';
    }

    // The two pages link to each other through the private token. A phone lookup
    // has no token, so it can only prefill the form with the phone digits - it
    // must never fall back to the sequential id, which is not a secret.
    function buildOrderFormUrl(order) {
        const token = order && order.public_token;
        if (token) return 'index.html?t=' + encodeURIComponent(token);
        if (order && order.phone_ending) return 'index.html?phone=' + encodeURIComponent(order.phone_ending);
        return 'index.html';
    }

    function buildTrackerUrl() {
        return currentToken ? window.location.pathname + '?t=' + encodeURIComponent(currentToken) : '';
    }

    window.onload = async function() {
        applyRateLimitUI();
        await loadRepairServices(supabaseClient);

        // Footer contact link: label only, never the number. The href carries
        // it so WhatsApp opens the chat, but nothing on the page displays it.
        const footerWa = $('footerWaLink');
        if (footerWa) footerWa.href = 'https://wa.me/' + getWhatsAppNumber();

        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get('t');
        const urlPhone = params.get('phone');

        if (urlToken) {
            trackByToken(urlToken);
            return;
        }

        if (urlPhone && /^\d{4}$/.test(urlPhone)) {
            $('trackPhoneInput').value = urlPhone;
            if (!checkRateLimit().allowed) applyRateLimitUI();
            else trackOrder();
        }
        $('trackPhoneInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') trackOrder();
        });
    };

    // Private link. This is the only path that returns a whole order.
    async function trackByToken(token) {
        setStatus('Loading your order...', '#7dd3fc', 0);
        clearAllViews();
        try {
            const { data, error } = await supabaseClient.rpc('order_by_token', { p_token: token });
            if (error) throw error;
            if (!data) {
                setStatus('');
                showNoActiveOrders('', false, true);
                return;
            }
            currentToken = data.public_token || token;
            currentOrder = data;
            currentOrderId = String(data.id);
            currentOrders = [data];
            currentPhone = data.phone_ending || null;
            recordSuccess();
            renderTracker(data);
            setStatus('');
        } catch (err) {
            console.error(err);
            setStatus('Could not load that link. Please message us on WhatsApp.', '#e57373', 6000);
        }
    }

    async function trackOrder() {
        const input = $('trackPhoneInput');
        const phone = input.value.trim();
        const btn = $('trackBtn');

        const rl = checkRateLimit();
        if (!rl.allowed) { applyRateLimitUI(); return; }

        if (phone.length !== 4 || !/^\d{4}$/.test(phone)) {
            setStatus('Please enter a valid 4-digit phone ID.', '#e57373');
            input.focus();
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span>Loading...</span>';
        setStatus('Looking up your order...', '#7dd3fc', 0);
        clearAllViews();

        try {
            const { data, error } = await supabaseClient.rpc('orders_by_phone', { p_phone: phone });
            if (error) throw error;

            // Status only by design: service, stage, status, dates. No games, no
            // price, no remarks, no courier numbers, no token.
            const all = Array.isArray(data) ? data : [];
            const activeOrders = all.filter(isActiveOrder);

            if (activeOrders.length === 0) {
                recordSuccess();
                currentPhone = phone;
                currentOrders = [];
                currentOrder = null;
                currentOrderId = null;
                // Same reset as the path below: a phone lookup must never leave a
                // stale token behind, or Copy Link hands out the wrong order's link.
                currentToken = null;
                setHeaderOrderPageLink('index.html?phone=' + encodeURIComponent(phone));
                setStatus('');
                showNoActiveOrders(phone, all.length > 0);
                return;
            }

            recordSuccess();
            currentPhone = phone;
            currentOrders = activeOrders;
            currentOrder = null;
            currentOrderId = null;
            currentToken = null;
            setHeaderOrderPageLink('index.html?phone=' + encodeURIComponent(phone));
            renderOrderList(activeOrders, true);
            setStatus('');

            // An address that already names an order opens it straight away, the
            // same way the private link opens its order. The state is replaced,
            // not pushed, so the back button still goes back where it came from.
            const wanted = findOrderByKey(new URLSearchParams(window.location.search), activeOrders);
            if (wanted) openOrderFromList(wanted, activeOrders.indexOf(wanted), true);

        } catch (err) {
            console.error(err);
            recordFailure();
            setStatus('Could not load your order. Please try again.', '#e57373', 6000);
        } finally {
            const post = checkRateLimit();
            if (post.allowed) { btn.disabled = false; btn.innerHTML = '<span>Track</span>'; }
            else applyRateLimitUI();
        }
    }

    function clearAllViews() {
        $('resultCard').classList.remove('show');
        $('orderListCard').classList.remove('show');
        $('noActiveCard').classList.remove('show');
        $('backToOrdersBar').classList.remove('show');
        // Same reset as resetOrderEditor on the order page: the token-only controls
        // must not survive into a phone lookup, which never had a token.
        ['viewOrderBtn', 'editOrderBtn'].forEach(id => {
            $(id).style.display = 'none';
            $(id).removeAttribute('href');
        });
        $('editWindowNotice').style.display = 'none';
        $('editWindowLink').removeAttribute('href');
        $('cancelOrderWrap').style.display = 'none';
    }

    function showNoActiveOrders(phone, hadAnyOrders, linkInvalid) {
        clearAllViews();
        const card = $('noActiveCard');
        const body = $('noActiveBody');
        const wa = getWhatsAppNumber();

        if (linkInvalid) {
            body.innerHTML = 'This link is no longer valid.<br><br>Order links now use a private code instead of an order number. If this link came from us it may have been mistyped, or the order may have been removed.<br><br>Message us and we\'ll send you a fresh link.';
        } else if (hadAnyOrders) {
            body.innerHTML = 'We found past orders for <strong>' + escapeHtml(phone) + '</strong>, but none are currently active - they\'ve either been completed or cancelled.<br><br>If you need to check a completed order, message us and we\'ll look it up.';
        } else {
            body.innerHTML = 'We couldn\'t find any orders for <strong>' + escapeHtml(phone) + '</strong>. If you just placed one, please wait a moment and try again.<br><br>Otherwise, message us on WhatsApp and we\'ll check.';
        }

        const prefill = linkInvalid
            ? "Hi, my order link isn't working any more. Could you send me a new one?"
            : 'Hi, I\'m checking on my order (phone ending ' + phone + ').';
        $('noActiveWaBtn').href = 'https://wa.me/' + wa + '?text=' + encodeURIComponent(prefill);
        card.classList.add('show');
    }

    // The stage copy lives in APP_CONFIG and is keyed only by stage, so showing
    // it here reveals nothing that orders_by_phone did not already return: any
    // customer at "In Progress" sees the same words. This is the detail a phone
    // lookup can safely give without the private token.
    function renderStageDetail(order) {
        const stages = APP_CONFIG.progressStages || [];
        const stage = order.progress_stage || 'Order Received';
        const msgs = getStageMessages(order) || {};

        let out = '<div class="order-stage-block">';

        // Where it is now, and what the customer should do.
        if (msgs.description) {
            out += '<div class="order-stage-desc">' + escapeHtml(msgs.description) + '</div>';
        }
        if (msgs.nextStep) {
            out += '<div class="order-stage-next"><strong>Next:</strong> ' + escapeHtml(msgs.nextStep) + '</div>';
        }

        // The progression, with the current stage marked.
        if (stages.length) {
            const here = stages.indexOf(stage);
            const steps = stages.map(function (s, i) {
                let cls = 'order-stage-step';
                if (i < here) cls += ' done';
                else if (i === here) cls += ' now';
                return '<span class="' + cls + '">' + escapeHtml(s) + '</span>';
            });
            out += '<div class="order-stage-track">' + steps.join('<span class="order-stage-arrow">&rsaquo;</span>') + '</div>';
        }

        return out + '</div>';
    }

    // statusOnly = the record came from orders_by_phone, so it has no games,
    // price, repairs or courier data. Show what it has and nothing more.
    function renderOrderList(orders, statusOnly) {
        clearAllViews();
        const card = $('orderListCard');
        const list = $('orderList');
        const subtitle = $('orderListSubtitle');

        list.innerHTML = '';
        subtitle.textContent = statusOnly
            ? 'We found ' + orders.length + ' active order' + (orders.length !== 1 ? 's' : '') + ' for ' + currentPhone + '. Tap one to see its progress.'
            : 'We found ' + orders.length + ' active orders for ' + currentPhone + '. Tap one to see its progress.';

        orders.forEach((order, index) => {
            const item = document.createElement('div');
            item.className = 'order-list-item';
            const stage = order.progress_stage || 'Order Received';
            let pillClass = '';
            if (stage === 'In Progress') pillClass = 'in-progress';
            else if (stage === 'Confirmed') pillClass = 'confirmed';

            const serviceLabels = {
                'jailbreak': 'Full Jailbreak' + (order.console_model ? ' (' + order.console_model + ')' : ''),
                'system_setup': 'System Setup',
                'system_update': 'System Update',
                'games_only': 'Games Only',
                'repair_only': 'Repair Only'
            };
            const serviceLabel = serviceLabels[order.service_type] || 'Order';
            const created = order.created_at
                ? new Date(order.created_at).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
                : '';

            let detailParts, heading, extra = '';
            if (statusOnly) {
                // No game count, no price: orders_by_phone never sends them, and
                // showing "0 games" because a field is absent would be a lie.
                // These are list positions, not shop order numbers, so label
                // them that way rather than implying the shop numbered them.
                detailParts = [escapeHtml(serviceLabel), escapeHtml(order.status || 'Pending')];
                heading = 'Order ' + (index + 1) + ' of ' + orders.length;
                extra = renderStageDetail(order);
            } else {
                const orderId = String(order.id || order.order_id);
                const gameCount = gameCountTotal(gameListOf(order));
                const rCount = Array.isArray(order.repairs) ? order.repairs.length : 0;
                const total = getOrderTotals(order).total ? 'RM' + getOrderTotals(order).total : '';
                detailParts = [escapeHtml(serviceLabel)];
                if (order.service_type !== 'repair_only') detailParts.push('<strong>' + gameCount + '</strong> game' + (gameCount !== 1 ? 's' : ''));
                if (rCount > 0) detailParts.push('<strong>' + rCount + '</strong> repair' + (rCount !== 1 ? 's' : ''));
                if (total) detailParts.push('<strong>' + total + '</strong>');
                heading = 'Order #' + escapeHtml(order.phone_ending || '');
                item.onclick = () => selectOrderFromList(orderId);
            }

            // A status-only card opens the tracker too. It shows the stage and
            // the status, which is all orders_by_phone ever sent, so opening it
            // cannot reveal anything the list did not already show.
            if (statusOnly) {
                item.onclick = () => openOrderFromList(order, index);
            }

            item.innerHTML = ''
                + '<div class="order-list-item-header">'
                + '  <div class="order-list-id">' + heading + '</div>'
                + '  <span class="order-list-stage-pill ' + pillClass + '">' + escapeHtml(stage) + '</span>'
                + '</div>'
                + '<div class="order-list-detail">' + detailParts.join(' &nbsp;·&nbsp; ') + '</div>'
                + extra
                + '<div class="order-list-date">Placed ' + escapeHtml(created) + '</div>';

            list.appendChild(item);
        });

        if (statusOnly) {
            const note = document.createElement('div');
            note.className = 'order-list-detail';
            note.style.marginTop = '1em';
            note.style.opacity = '.75';
            note.innerHTML = 'This shows progress only, so nobody can read your order by ' +
                'guessing a phone number. Open the private link we sent you to see your full ' +
                'order, repairs and courier details.';
            list.appendChild(note);
        }

        card.classList.add('show');
    }

    function selectOrderFromList(orderId) {
        const order = currentOrders.find(o => String(o.id || o.order_id) === String(orderId));
        if (!order) return;
        openOrderFromList(order, currentOrders.indexOf(order));
    }

    // Opening an order from the list. The order is handed over rather than
    // looked up by id, because a status-only record from orders_by_phone may
    // not carry an id at all.
    function openOrderFromList(order, index, replace) {
        currentOrder = order;
        currentOrderId = (order.id || order.order_id) ? String(order.id || order.order_id) : null;
        renderTracker(order);
        $('orderListCard').classList.remove('show');
        $('noActiveCard').classList.remove('show');
        $('backToOrdersBar').classList.add('show');
        const url = window.location.pathname + '?phone=' + encodeURIComponent(currentPhone) +
            '&' + orderListKey(order, index);
        // replace is for the address that already names this order, so the back
        // button still leads somewhere sensible.
        if (replace) window.history.replaceState({ orderId: currentOrderId }, '', url);
        else window.history.pushState({ orderId: currentOrderId }, '', url);
    }

    // How an order is named in the address bar. The id is the natural key, but
    // a status-only record may not have one, so the position in the list is the
    // fallback.
    function orderListKey(order, index) {
        const id = order.id || order.order_id;
        if (id !== undefined && id !== null && id !== '') return 'id=' + encodeURIComponent(String(id));
        return 'pos=' + encodeURIComponent(String(index));
    }

    // The order named in the address bar, if the list still holds it.
    function findOrderByKey(params, orders) {
        const id = params.get('id');
        if (id) {
            const byId = orders.find(o => String(o.id || o.order_id) === String(id));
            if (byId) return byId;
        }
        const pos = params.get('pos');
        if (pos !== null && pos !== '') {
            const idx = parseInt(pos, 10);
            if (!isNaN(idx) && idx >= 0 && idx < orders.length) return orders[idx];
        }
        return null;
    }

    function showOrderListAgain() {
        if (!currentOrders || currentOrders.length < 1) return;
        $('resultCard').classList.remove('show');
        $('backToOrdersBar').classList.remove('show');
        renderOrderList(currentOrders, !currentToken);
        const url = window.location.pathname + (currentToken
            ? '?t=' + encodeURIComponent(currentToken)
            : '?phone=' + encodeURIComponent(currentPhone));
        window.history.pushState({}, '', url);
        if (currentPhone) setHeaderOrderPageLink('index.html?phone=' + encodeURIComponent(currentPhone));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    window.addEventListener('popstate', function(e) {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('t');
        if (token && token !== currentToken) { trackByToken(token); return; }
        if (!currentPhone || !currentOrders) return;
        const order = findOrderByKey(params, currentOrders);
        if (order) {
            currentOrder = order;
            currentOrderId = (order.id || order.order_id) ? String(order.id || order.order_id) : null;
            renderTracker(order);
            $('orderListCard').classList.remove('show');
            $('backToOrdersBar').classList.add('show');
            return;
        }
        $('resultCard').classList.remove('show');
        $('backToOrdersBar').classList.remove('show');
        if (currentOrders.length >= 1) renderOrderList(currentOrders, !currentToken);
        if (currentPhone) setHeaderOrderPageLink('index.html?phone=' + encodeURIComponent(currentPhone));
    });

    async function refreshOrder() {
        if (!currentToken) return;
        const btn = $('refreshBtn');
        btn.disabled = true;
        btn.classList.add('loading');
        try {
            const { data, error } = await supabaseClient.rpc('order_by_token', { p_token: currentToken });
            if (error) throw error;
            if (data) {
                currentOrder = data;
                currentOrders = [data];
                renderTracker(data);
                setStatus('Status updated.', '#00e676', 3000);
            } else {
                setStatus('This order is no longer available.', '#e57373', 5000);
            }
        } catch (err) {
            console.error(err);
            setStatus('Could not refresh. Please try again.', '#e57373', 4000);
        } finally {
            btn.disabled = false;
            btn.classList.remove('loading');
        }
    }

    function copyTrackerUrl(btnElement) {
        // Private link when we have a token. Without one (a phone lookup) fall
        // back to the phone URL, which shows status only - never ?order=<id>.
        const tokenUrl = buildTrackerUrl();
        let url = tokenUrl
            ? window.location.origin + tokenUrl
            : window.location.origin + window.location.pathname + '?phone=' + encodeURIComponent(currentPhone || '');
        if (!url || url.endsWith('=')) { alert('No order to copy a link for.'); return; }
        navigator.clipboard.writeText(url).then(() => {
            const originalText = btnElement.innerHTML;
            btnElement.innerHTML = 'Copied';
            btnElement.style.background = '#7dd3fc';
            btnElement.style.color = '#14110a';
            btnElement.style.borderColor = '#7dd3fc';
            setTimeout(() => {
                btnElement.innerHTML = originalText;
                btnElement.style.background = '#2e2716';
                btnElement.style.color = '#7dd3fc';
                btnElement.style.borderColor = '#3a3018';
            }, 2000);
        }).catch(err => { alert('Failed to copy link: ' + err); });
    }

    function setStatus(text, color = '#e8dcc0', autoDismissMs = 0) {
        const el = $('statusMsg');
        el.classList.remove('fading');
        el.style.color = color;
        el.innerText = text;
        if (autoDismissMs > 0) {
            setTimeout(() => {
                el.classList.add('fading');
                setTimeout(() => { if (el.classList.contains('fading')) { el.innerText = ''; el.classList.remove('fading'); } }, 400);
            }, autoDismissMs);
        }
    }

    // ===== SHIPPING (stage-aware) =====
    // Inbound visible: Confirmed + In Progress
    // Outbound visible: Ready + Completed
    function renderShipping(order) {
        const container = $('shippingContainer');
        if (!container) return;

        const stage = order.progress_stage || 'Order Received';
        const isCancelled = order.status === 'Cancelled';

        const showInbound  = !isCancelled && (stage === 'Confirmed' || stage === 'In Progress');
        const showOutbound = !isCancelled && (stage === 'Ready' || stage === 'Completed');

        const hasInbound  = showInbound  && !!(order.tracking_inbound_number  && order.tracking_inbound_number.trim());
        const hasOutbound = showOutbound && !!(order.tracking_outbound_number && order.tracking_outbound_number.trim());

        if (!hasInbound && !hasOutbound) { container.innerHTML = ''; return; }

        let html = '<div class="shipping-card">';
        html += '<div class="shipping-card-title"><span class="icon">&#128230;</span>Parcel Tracking</div>';

        if (hasInbound)  html += buildShippingRow('Inbound — You &rarr; Us',  order.tracking_inbound_courier,  order.tracking_inbound_number);
        if (hasOutbound) html += buildShippingRow('Outbound — Us &rarr; You', order.tracking_outbound_courier, order.tracking_outbound_number);

        html += '</div>';
        container.innerHTML = html;
    }

    function buildShippingRow(label, courierKey, number) {
        const courier = COURIERS[courierKey] || COURIERS['other'];
        const trackingUrl = courier.pattern ? courier.pattern.replace('{n}', encodeURIComponent(number)) : '';
        const needsVerify = (courierKey === 'jnt'); // J&T requires phone verification

        let html = '<div class="shipping-row">';
        html += '<div class="shipping-label">' + label + '</div>';
        html += '<div class="shipping-courier">' + escapeHtml(courier.label) + '</div>';
        html += '<div class="shipping-number">' + escapeHtml(number) + '</div>';
        if (needsVerify) {
            html += '<div class="shipping-hint">' + escapeHtml(courier.label) + ' may ask for the last 4 digits of your phone for verification.</div>';
        }
        if (trackingUrl) {
            html += '<a class="shipping-btn" href="' + trackingUrl + '" target="_blank" rel="noopener noreferrer">Track Parcel &#8599;</a>';
        }
        html += '</div>';
        return html;
    }

    /**
     * Everything on this page that needs the private token.
     *
     * Driven by the order's own token and never by currentToken: a phone lookup
     * can never produce one, and must not inherit a token left behind by an
     * earlier private-link visit.
     *
     *   View Order - the order itself. Shown for any order we hold a token for,
     *                locked or not, because a finished order is still worth reading.
     *   Edit Order - the same page with ?edit=1, which drops the customer
     *                straight into the form. Hidden once locked, because the order
     *                page would then only show the locked notice pointing at WhatsApp.
     *   notice     - spells out that the edit window closes once confirmed, so
     *                "No action needed yet" is not read as "nothing you can do".
     *   cancel     - self-service cancellation, on the tracker as well as the
     *                order page. Same window as Edit, because both are refused
     *                server-side once the shop has confirmed the details.
     */
    function updateOrderAccess(order) {
        const token = order && order.public_token;
        const locked = isOrderLocked(order);
        const viewBtn = $('viewOrderBtn');
        const editBtn = $('editOrderBtn');
        const notice = $('editWindowNotice');
        const noticeLink = $('editWindowLink');
        const cancelWrap = $('cancelOrderWrap');

        if (!token) {
            [viewBtn, editBtn].forEach(b => { b.style.display = 'none'; b.removeAttribute('href'); });
            notice.style.display = 'none';
            noticeLink.removeAttribute('href');
            cancelWrap.style.display = 'none';
            return;
        }

        const base = 'index.html?t=' + encodeURIComponent(token);
        viewBtn.href = base;
        viewBtn.style.display = '';

        if (locked) {
            editBtn.style.display = 'none';
            editBtn.removeAttribute('href');
            notice.style.display = 'none';
            noticeLink.removeAttribute('href');
            cancelWrap.style.display = 'none';
            return;
        }

        editBtn.href = base + '&edit=1';
        editBtn.style.display = '';
        noticeLink.href = base + '&edit=1';
        notice.style.display = '';
        cancelWrap.style.display = '';
    }

    /**
     * Self-service cancellation from the tracker.
     *
     * Mirrors cancelOrder() on index.html: same RPC, same lock rule, same
     * "cannot be undone" warning. The check here is only to save a pointless
     * round trip - cancel_order re-checks server-side and simply reports back
     * that the order is too far along.
     */
    async function cancelTrackedOrder() {
        const order = currentOrder;
        if (!order) return;

        const token = order.public_token || currentToken;
        if (!token || !isOrderCancellable(order)) {
            setStatus('This order can no longer be cancelled here. Please message us on WhatsApp.', '#e57373', 6000);
            return;
        }

        const confirmed = confirm("Cancel this order?\n\nThis can't be undone. You'll need to place a new order if you change your mind.");
        if (!confirmed) return;

        const btn = $('cancelOrderBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }

        try {
            const { data, error } = await supabaseClient.rpc('cancel_order', { p_token: token });
            if (error) throw error;
            if (!data || data.cancelled !== true) {
                setStatus('This order can no longer be cancelled here. Please message us on WhatsApp.', '#e57373', 6000);
                return;
            }

            // Re-render from the local copy rather than re-fetching: the row we
            // hold is the one that was just cancelled, and order_by_token is
            // the only call that returns tokens anyway.
            const nowIso = new Date().toISOString();
            order.status = 'Cancelled';
            order.progress_stage = 'Cancelled';
            order.progress_updated_at = nowIso;
            order.updated_at = nowIso;
            currentOrder = order;
            currentOrders = [order];
            renderTracker(order);
            setStatus('Order cancelled. Sorry to see you go.', '#e57373', 6000);
        } catch (err) {
            console.error(err);
            setStatus('Could not cancel. Please try again or message us on WhatsApp.', '#e57373', 6000);
            if (btn) { btn.disabled = false; btn.textContent = 'Cancel Order'; }
        }
    }

    function renderTracker(order) {
        // A phone lookup never carries a token, and a status-only record has no
        // games, price or repairs in it. Counting what is missing would print
        // "0 games" for an order that has games, so the counts are left out and
        // only what the record really holds is shown.
        const statusOnly = !currentToken;

        if (statusOnly) {
            // A list position, not a shop order number: orders_by_phone does not
            // send one and the shop never numbered these orders that way.
            let idx = currentOrders ? currentOrders.indexOf(order) : -1;
            if (idx === -1 && currentOrders && (order.id || order.order_id)) {
                idx = currentOrders.findIndex(o => String(o.id || o.order_id) === String(order.id || order.order_id));
            }
            const pos = idx > -1 ? idx + 1 : 1;
            const total = currentOrders ? currentOrders.length : 1;
            $('summaryId').innerText = `Order ${pos} of ${total}`;
        } else {
            $('summaryId').innerText = `Order #${order.phone_ending || 'N/A'}`;
        }

        // The order form opens on the private token, never on the sequential id.
        // The old ?order=<id> link is exactly what the token replaced, and
        // index.html now treats it as a dead link.
        setHeaderOrderPageLink(buildOrderFormUrl(order));
        updateOrderAccess(order);

        const serviceLabels = {
            'jailbreak': `Full Jailbreak${order.console_model ? ' (' + order.console_model + ')' : ''}`,
            'system_setup': 'System Setup',
            'system_update': 'System Update',
            'games_only': 'Games Only',
            'repair_only': 'Repair Only' + (order.console_model ? ' (' + order.console_model + ')' : '')
        };
        const serviceLabel = serviceLabels[order.service_type] || 'Order';

        const gameCount = gameCountTotal(gameListOf(order));
        const sizeGb = order.total_size_gb ? Number(order.total_size_gb).toFixed(1) : '0';
        const rCount = Array.isArray(order.repairs) ? order.repairs.length : 0;

        const detailParts = [];
        if (statusOnly) {
            // Service and status: the two things a status-only record carries.
            detailParts.push(escapeHtml(serviceLabel));
            detailParts.push(escapeHtml(order.status || 'Pending'));
        } else {
            detailParts.push(serviceLabel);
            if (order.service_type !== 'repair_only') {
                detailParts.push(`<strong>${gameCount}</strong> game${gameCount !== 1 ? 's' : ''}`);
                detailParts.push(`<strong>${sizeGb}</strong> GB`);
            }
            if (rCount > 0) detailParts.push(`<strong>${rCount}</strong> repair${rCount !== 1 ? 's' : ''}`);
        }

        $('summaryDetail').innerHTML = detailParts.join(' &nbsp;<span style="color:#6a6357;">·</span>&nbsp; ');
        $('summaryPlaced').className = 'order-placed-line';
        $('summaryPlaced').innerHTML = order.created_at
            ? `Placed ${new Date(order.created_at).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`
            : '';

        const stages = APP_CONFIG.progressStages || ['Order Received','Confirmed','In Progress','Ready','Completed'];
        let currentStage = order.progress_stage || 'Order Received';
        if (order.status === 'Cancelled') currentStage = 'Cancelled';

        const mainProgress = $('mainProgress');
        mainProgress.querySelectorAll('.main-step').forEach(el => el.remove());
        const currentIndex = stages.indexOf(currentStage);

        stages.forEach((stage, idx) => {
            const isCompleted = (currentIndex > -1 && idx < currentIndex);
            const isCurrent = (idx === currentIndex);
            const step = document.createElement('div');
            step.className = 'main-step' + (isCompleted ? ' completed' : '') + (isCurrent ? ' current' : '');

            const icon = document.createElement('div');
            icon.className = 'main-step-icon';
            icon.innerText = isCompleted ? '\u2713' : (STAGE_ICONS[stage] || '\u2022');

            const label = document.createElement('div');
            label.className = 'main-step-label';
            label.innerText = stage;

            step.appendChild(icon);
            step.appendChild(label);
            mainProgress.appendChild(step);
        });

        const lineFill = $('progressLineFill');
        if (currentIndex <= 0 || stages.length <= 1) lineFill.style.width = '0%';
        else {
            const usablePercent = 84;
            const stepCount = stages.length - 1;
            const percent = (currentIndex / stepCount) * usablePercent;
            lineFill.style.width = percent + '%';
        }

        const currentCard = $('currentStageCard');
        const waWrap = document.querySelector('.wa-button-wrap');
        const etaBox = $('currentStageEta');

        if (currentStage === 'Cancelled') {
            currentCard.style.display = 'none';
            $('substagesContainer').innerHTML = `<div class="cancelled-banner"><span class="icon">&#10007;</span><div class="msg"><strong>Order Cancelled.</strong><br>This order has been cancelled. If you believe this is a mistake, please contact us on WhatsApp.</div></div>`;
            waWrap.style.display = 'block';
        } else {
            currentCard.style.display = 'block';
            $('currentIcon').innerText = STAGE_ICONS[currentStage] || '\u25CF';
            $('currentStageName').innerText = currentStage;

            // All stage copy comes from getStageMessages() in config.js, which
            // also swaps in the "shipped" wording once a tracking number exists
            // and keeps the status line distinct from the next-step line.
            const msg = getStageMessages(order);
            $('currentStageDesc').innerText = msg.description;

            const nextStepEl = $('nextStepHint');
            const nextStepTextEl = $('nextStepText');
            // No next step (e.g. a completed order) -> hide the box entirely
            // rather than showing filler under an identical status line.
            if (msg.nextStep) { nextStepTextEl.innerHTML = msg.nextStep; nextStepEl.classList.remove('hidden'); }
            else nextStepEl.classList.add('hidden');

            if (order.progress_updated_at) {
                $('currentStageUpdated').innerHTML = `Last updated: <strong>${formatTimeAgo(order.progress_updated_at)}</strong>`;
            } else $('currentStageUpdated').innerText = '';

            const substagesContainer = $('substagesContainer');
            substagesContainer.innerHTML = '';
            etaBox.style.display = 'none';

            if (currentStage === 'In Progress') {
                const stagesList = getEffectiveSubStages(order);
                const currentSub = order.progress_substage || (stagesList[0] || null);
                const currentSubIdx = stagesList.indexOf(currentSub);

                if (APP_CONFIG.showEstimatedTime && currentSub && APP_CONFIG.subStageEstimatedTimes && APP_CONFIG.subStageEstimatedTimes[currentSub]) {
                    etaBox.innerHTML = `Estimated time: <strong>${APP_CONFIG.subStageEstimatedTimes[currentSub]}</strong>`;
                    etaBox.style.display = 'inline-flex';
                }

                if (stagesList.length > 1) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'substages';
                    wrapper.innerHTML = `<div class="substages-title">Work in progress — detailed steps</div>`;
                    const list = document.createElement('div');
                    list.className = 'substage-list';

                    stagesList.forEach((sub, idx) => {
                        const isDone = (idx < currentSubIdx);
                        const isCur = (idx === currentSubIdx);
                        const item = document.createElement('div');
                        item.className = 'substage-item' + (isDone ? ' completed' : '') + (isCur ? ' current' : '');

                        let metaLine = '';
                        if (sub === 'Game Installation' && isCur && !isDone) {
                            const gc = gameCountTotal(gameListOf(order));
                            const gs = order.total_size_gb ? Number(order.total_size_gb).toFixed(1) : '0';
                            if (gc > 0) metaLine = `Installing ${gc} game${gc !== 1 ? 's' : ''} · ${gs} GB total`;
                        }
                        if ((sub === 'Repair' || sub === 'Device Repair') && isCur && !isDone && rCount > 0) {
                            metaLine = `Working on ${rCount} repair${rCount !== 1 ? 's' : ''}`;
                        }

                        item.innerHTML = `
                            <div class="substage-icon">${isDone ? '&#10003;' : (isCur ? '&#9680;' : '&#9675;')}</div>
                            <div class="substage-content">
                                <div class="substage-name">${sub}</div>
                                ${metaLine ? `<div class="substage-meta">${metaLine}</div>` : ''}
                            </div>
                            <div class="substage-badge">${isDone ? 'Done' : (isCur ? 'Now' : 'Pending')}</div>
                        `;
                        list.appendChild(item);
                    });

                    wrapper.appendChild(list);
                    substagesContainer.appendChild(wrapper);
                } else if (stagesList.length === 1) {
                    const simple = document.createElement('div');
                    simple.className = 'substage-simple';
                    const desc = (APP_CONFIG.subStageDescriptions && APP_CONFIG.subStageDescriptions[stagesList[0]]) || 'Working on it...';
                    const gc = gameCountTotal(gameListOf(order));
                    const gs = order.total_size_gb ? Number(order.total_size_gb).toFixed(1) : '0';
                    let detail = '';
                    if (gc > 0 && stagesList[0] === 'Game Installation') detail = `<div style="margin-top:6px; font-size:12.5px; color:#7dd3fc; font-weight:600;">Installing ${gc} game${gc !== 1 ? 's' : ''} · ${gs} GB total</div>`;

                    simple.innerHTML = `
                        <span class="spin-icon">&#8635;</span>
                        <div class="substage-simple-content">
                            <div>${desc}</div>
                            ${detail}
                        </div>
                    `;
                    substagesContainer.appendChild(simple);
                }
            }
        }

        // Shipping (stage-aware)
        renderShipping(order);

        const wa = getWhatsAppNumber();
        const waBtn = $('waChatBtn');
        if (wa) {
            const prefill = `Hi, I'd like to ask about my order #${order.phone_ending || ''}.`;
            waBtn.href = `https://wa.me/${wa}?text=${encodeURIComponent(prefill)}`;
            waBtn.style.display = 'inline-flex';
        } else waBtn.style.display = 'none';

        $('resultCard').classList.add('show');
    }

    function formatTimeAgo(isoString) {
        const then = new Date(isoString).getTime();
        const now = Date.now();
        const sec = Math.floor((now - then) / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min} min ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr} hour${hr !== 1 ? 's' : ''} ago`;
        const day = Math.floor(hr / 24);
        if (day < 30) return `${day} day${day !== 1 ? 's' : ''} ago`;
        const mo = Math.floor(day / 30);
        return `${mo} month${mo !== 1 ? 's' : ''} ago`;
    }
    