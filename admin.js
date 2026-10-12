    window.addEventListener('error', function(e) {
        if (e && e.message && e.message.indexOf('ResizeObserver') === -1) {
            console.error('JS ERROR:', e.message, 'line', e.lineno);
        }
    });

    var supabaseClient = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);

    // ===== BODY SCROLL LOCK =====
    var _modalLockCount = 0;
    var _savedScrollY = 0;
    function lockBodyScroll() {
        if (_modalLockCount === 0) {
            _savedScrollY = window.scrollY || window.pageYOffset || 0;
            document.body.style.position = 'fixed';
            document.body.style.top = '-' + _savedScrollY + 'px';
            document.body.style.left = '0';
            document.body.style.right = '0';
            document.body.style.width = '100%';
            document.body.style.overflow = 'hidden';
        }
        _modalLockCount++;
    }
    function unlockBodyScroll() {
        if (_modalLockCount <= 0) return;
        _modalLockCount--;
        if (_modalLockCount === 0) {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.width = '';
            document.body.style.overflow = '';
            window.scrollTo(0, _savedScrollY);
        }
    }

    var _inlinePromptResolver = null;
    function openInlinePrompt(opts) {
        document.getElementById('inlinePromptTitle').textContent = opts.title || 'Edit';
        document.getElementById('inlinePromptLabel').textContent = opts.label || 'Value:';
        var input = document.getElementById('inlinePromptInput');
        input.value = opts.value || '';
        input.placeholder = opts.placeholder || '';
        if (opts.inputmode) input.setAttribute('inputmode', opts.inputmode);
        else input.removeAttribute('inputmode');
        if (opts.type) input.setAttribute('type', opts.type);
        else input.setAttribute('type', 'text');

        var saveBtn = document.getElementById('inlinePromptSave');
        var newSave = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSave, saveBtn);

        document.getElementById('inlinePromptOverlay').style.display = 'flex';
        lockBodyScroll();
        setTimeout(function() { input.focus(); input.select(); }, 100);

        _inlinePromptResolver = function(result) {
            if (result === undefined) return;
            closeInlinePrompt();
            if (opts.onSave) opts.onSave(result);
        };

        newSave.addEventListener('click', function() {
            _inlinePromptResolver(input.value);
        });
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); _inlinePromptResolver(input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); _inlinePromptResolver(null); }
        });
    }
    function closeInlinePrompt() {
        document.getElementById('inlinePromptOverlay').style.display = 'none';
        _inlinePromptResolver = null;
        // Reset display tweaks from inlineConfirm
        var input = document.getElementById('inlinePromptInput');
        if (input) input.style.display = '';
        var label = document.getElementById('inlinePromptLabel');
        if (label) { label.style.whiteSpace = ''; label.style.fontSize = '13px'; label.style.lineHeight = ''; }
        var saveBtn = document.getElementById('inlinePromptSave');
        if (saveBtn) saveBtn.textContent = 'Save';
        unlockBodyScroll();
    }

    function inlineConfirm(opts) {
        openInlinePrompt({
            title: opts.title || 'Confirm',
            label: opts.message || 'Are you sure?',
            value: '',
            placeholder: '(not used for confirm)',
            onSave: function() { if (opts.onConfirm) opts.onConfirm(); }
        });
        // Hide the input for confirm-style — it's just a prompt with no text field
        var input = document.getElementById('inlinePromptInput');
        if (input) { input.style.display = 'none'; }
        var label = document.getElementById('inlinePromptLabel');
        if (label) { label.style.whiteSpace = 'pre-wrap'; label.style.fontSize = '13.5px'; label.style.lineHeight = '1.5'; }
        var saveBtn = document.getElementById('inlinePromptSave');
        if (saveBtn) saveBtn.textContent = opts.confirmLabel || 'Confirm';
    }

    var allOrders = [];
    var allRepairServices = [];
    var currentStatusFilter = 'NEEDS'; // default view: action-needed
    var currentCatalogFilter = 'ALL';
    var currentModalOrderId = null;
    var currentRemarksOrderId = null;
    var currentModalOrder = null;
    var orderCountByPhone = {};
    var bulkSelectedIds = {};
    var expandedChecklists = {}; // orderId -> bool

    var PROGRESS_STAGES = (APP_CONFIG.progressStages) || ['Order Received', 'Confirmed', 'In Progress', 'Ready', 'Completed'];
    var STAGE_TO_STATUS = {
        'Order Received':   'Pending',
        'Confirmed':        'Pending',
        'In Progress':      'In Progress',
        'Ready':            'Ready',
        'Completed':        'Completed'
    };
    var STAGE_ICONS = {
        'Order Received':   '\u{1F4E5}',
        'Confirmed':        '\u{1F4DD}',
        'In Progress':      '\u{1F527}',
        'Ready':            '\u{1F4E6}',
        'Completed':        '\u2705'
    };

    const COURIERS = {
        'jnt':       { label: 'J&T Express',   pattern: 'https://www.jtexpress.my/tracking/{n}' },
        'poslaju':   { label: 'Pos Laju',      pattern: 'https://tracking.pos.com.my/tracking?trackingNumber={n}' },
        'gdex':      { label: 'GDEX',          pattern: 'https://www.gdexpress.com/malaysia/e-tracking/?tracking_no={n}' },
        'citylink':  { label: 'City-Link',     pattern: 'https://www.citylinkexpress.com/track/?tracking_no={n}' },
        'dhl':       { label: 'DHL eCommerce', pattern: 'https://www.dhl.com/my-en/home/tracking.html?tracking-id={n}' },
        'ninjavan':  { label: 'Ninja Van',     pattern: 'https://www.ninjavan.co/en-my/tracking?id={n}' },
        'other':     { label: 'Courier',       pattern: '' }
    };

    function openTrackingFromModal() {
        if (!currentModalOrder) return;
        var url = buildTrackLink(currentModalOrder);
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    // Since the id stopped working as a link, these two are the only way a
    // customer gets back into an order. They are shown as text rather than
    // copied straight to the clipboard, because the shop pastes them into
    // WhatsApp by hand and needs to see which link is which.
    function renderModalLinks(order) {
        var orderUrl = buildEditUrl(order);
        var trackUrl = buildTrackingUrl(order);
        var orderInput = document.getElementById('modalOrderLinkInput');
        var trackInput = document.getElementById('modalTrackLinkInput');
        var orderBtn = document.getElementById('modalOrderLinkBtn');
        var trackBtn = document.getElementById('modalTrackLinkBtn');
        var note = document.getElementById('modalLinksNote');

        orderInput.value = orderUrl || '';
        trackInput.value = trackUrl || '';
        // A disabled button with no explanation reads as a broken page, so the
        // reason is spelled out underneath instead.
        orderBtn.disabled = !orderUrl;
        trackBtn.disabled = !trackUrl;
        note.style.display = orderUrl ? 'none' : '';
    }

    function copyModalLink(inputId, btnId) {
        var input = document.getElementById(inputId);
        if (!input || !input.value) return;
        var url = input.value;
        var btn = document.getElementById(btnId);
        var original = btn ? btn.textContent : '';
        var done = function () {
            if (!btn) return;
            btn.textContent = 'Copied';
            setTimeout(function () { btn.textContent = original; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(function () { prompt('Copy this link:', url); });
        } else {
            prompt('Copy this link:', url);
        }
    }

    function login() {
        var emailEl = document.getElementById('adminEmail');
        var passEl = document.getElementById('adminPassword');
        var email = emailEl ? emailEl.value.trim() : '';
        var password = passEl ? passEl.value : '';
        if (!email || !password) { alert('Please enter both email and password.'); return; }
        supabaseClient.auth.signInWithPassword({ email: email, password: password })
            .then(function(result) {
                if (result.error) { alert('Login failed: ' + result.error.message); return; }
                if (!result.data || !result.data.session) { alert('Login returned no session.'); return; }
                location.reload();
            })
            .catch(function(err) { alert('Login exception: ' + (err && err.message ? err.message : String(err))); });
    }
    function logout() { supabaseClient.auth.signOut().then(function() { location.reload(); }); }

    document.addEventListener('DOMContentLoaded', function() {
        var loginBtn = document.getElementById('loginBtn');
        if (loginBtn) loginBtn.addEventListener('click', function(e) { e.preventDefault(); login(); });
        var passEl = document.getElementById('adminPassword');
        if (passEl) passEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); login(); } });

    document.addEventListener('click', function(e) {
        if (!e.target || !e.target.classList) return;
        var t = e.target;
        var id = t.getAttribute ? t.getAttribute('data-order-id') : null;
        if (t.classList.contains('view-btn')) openOrderModal(id);
        else if (t.classList.contains('delete-btn')) deleteOrder(id);
        else if (t.classList.contains('order-copy-btn')) copyOrderNo(id, t);
        else if (t.closest && t.closest('.checklist-toggle')) {
            var tog = t.closest('.checklist-toggle');
            toggleChecklist(tog.getAttribute('data-order-id'));
        }
        else if (!t.classList.contains('bulk-checkbox') && !t.closest('.card-select-wrap')) {
            var clItem = t.closest ? t.closest('.checklist-item') : null;
            if (clItem) {
                var clOrderId = clItem.getAttribute('data-order-id');
                var clStep = clItem.getAttribute('data-step');
                if (clOrderId && clStep) {
                    toggleChecklistItem(clOrderId, clStep);
                    return;
                }
            }
        }
    });

        document.addEventListener('change', function(e) {
            if (!e.target || !e.target.classList) return;
            if (e.target.classList.contains('bulk-checkbox')) {
                var id = e.target.getAttribute('data-order-id');
                if (e.target.checked) bulkSelectedIds[String(id)] = true;
                else delete bulkSelectedIds[String(id)];
                var card = e.target.closest ? e.target.closest('.order-card') : null;
                if (card) {
                    if (e.target.checked) card.classList.add('selected-for-bulk');
                    else card.classList.remove('selected-for-bulk');
                }
                updateBulkBarUI();
            }
        });

        supabaseClient.auth.getSession().then(function(res) {
            if (res && res.data && res.data.session) {
                document.getElementById('loginOverlay').style.display = 'none';
                document.getElementById('adminDashboard').style.display = 'block';
                loadAll();
            }
        });
    });

    async function loadAll() {
        await loadRepairServices(supabaseClient);
        await loadRepairsAdmin();
        loadOrders();
    }

    function loadOrders() {
        var container = document.getElementById('ordersContainer');
        container.innerHTML = '<div class="no-orders">Loading orders...</div>';
        supabaseClient.from('orders').select('*').order('created_at', { ascending: false })
            .then(function(res) {
                if (res.error) { alert('Error loading orders: ' + res.error.message); return; }
                allOrders = res.data || [];
                orderCountByPhone = {};
                allOrders.forEach(function(o) {
                    var p = o.phone_ending || '';
                    orderCountByPhone[p] = (orderCountByPhone[p] || 0) + 1;
                });
                bulkSelectedIds = {};
                updateStats();
                filterAndRenderOrders();
            });
    }

    function loadRepairsAdmin() {
        return supabaseClient.from('repair_services').select('*').order('sort_order', { ascending: true })
            .then(function(res) {
                if (res.error) { allRepairServices = []; return; }
                allRepairServices = res.data || [];
                return allRepairServices;
            });
    }

    function refreshCurrentTab() {
        var ordersTab = document.getElementById('tabOrders');
        if (ordersTab && ordersTab.classList.contains('active')) loadOrders();
        else Promise.all([loadRepairServices(supabaseClient), loadRepairsAdmin()]).then(renderCatalog);
    }

    function switchTab(name, btn) {
        document.querySelectorAll('.admin-tab').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-view').forEach(function(v) { v.classList.remove('active'); });
        btn.classList.add('active');
        if (name === 'orders') document.getElementById('tabOrders').classList.add('active');
        else if (name === 'repairs') { document.getElementById('tabRepairs').classList.add('active'); renderCatalog(); }
    }

    function findOrder(orderId) {
        var target = String(orderId);
        for (var i = 0; i < allOrders.length; i++) {
            var o = allOrders[i];
            if (String(o.id) === target || String(o.order_id) === target) return o;
        }
        return null;
    }
    function serviceLabel(order) {
        var labels = {
            'jailbreak': 'Full Jailbreak' + (order.console_model ? ' (' + order.console_model + ')' : ''),
            'system_setup': 'System Setup',
            'system_update': 'System Update',
            'games_only': 'Games Only',
            'repair_only': 'Repair Only' + (order.console_model ? ' (' + order.console_model + ')' : '')
        };
        return labels[order.service_type] || 'Order';
    }

    // ===== CHECKLIST LOGIC =====
    // Build the ordered checklist for an order, based on:
    //   - service_type
    //   - has repairs
    //   - games count
    // Steps marked autoStage are the ones that set progress_stage.
    // Steps marked autoSub are the ones that set progress_substage.
    function buildChecklist(order) {
        var serviceType = order.service_type || 'jailbreak';
        var repairs = getEnrichedRepairs(order);
        var repairCount = repairs.length;
        var games = gameListOf(order);
        var gameCount = games.length;

        var items = [];
        items.push({ key: 'confirmed',  label: 'Order confirmed',          autoStage: 'Confirmed' });
        items.push({ key: 'received',   label: 'Console received',         autoStage: null, autoSub: 'Received' });

        if (serviceType === 'jailbreak') {
            items.push({ key: 'modchip',  label: 'Modchip installed',       autoSub: 'Modchip Installation' });
            if (repairCount > 0) items.push({ key: 'repair',  label: repairCount + ' repair' + (repairCount === 1 ? '' : 's') + ' done',  autoSub: 'Device Repair' });
            items.push({ key: 'setup',    label: 'System setup',            autoSub: 'System Setup' });
            if (gameCount > 0) items.push({ key: 'games',    label: gameCount + ' game' + (gameCount === 1 ? '' : 's') + ' installed', autoSub: 'Game Installation' });
        } else if (serviceType === 'system_setup') {
            if (repairCount > 0) items.push({ key: 'repair',  label: repairCount + ' repair' + (repairCount === 1 ? '' : 's') + ' done',  autoSub: 'Device Repair' });
            items.push({ key: 'setup',    label: 'System setup',            autoSub: 'System Setup' });
            if (gameCount > 0) items.push({ key: 'games',    label: gameCount + ' game' + (gameCount === 1 ? '' : 's') + ' installed', autoSub: 'Game Installation' });
        } else if (serviceType === 'system_update') {
            if (repairCount > 0) items.push({ key: 'repair',  label: repairCount + ' repair' + (repairCount === 1 ? '' : 's') + ' done',  autoSub: 'Device Repair' });
            items.push({ key: 'setup',    label: 'System updated',          autoSub: 'System Update' });
            if (gameCount > 0) items.push({ key: 'games',    label: gameCount + ' game' + (gameCount === 1 ? '' : 's') + ' installed', autoSub: 'Game Installation' });
        } else if (serviceType === 'games_only') {
            if (gameCount > 0) items.push({ key: 'games',    label: gameCount + ' game' + (gameCount === 1 ? '' : 's') + ' installed', autoSub: 'Game Installation' });
        } else if (serviceType === 'repair_only') {
            items.push({ key: 'diagnosis', label: 'Diagnosis done',         autoSub: 'Diagnosis' });
            items.push({ key: 'repair',    label: repairCount + ' repair' + (repairCount === 1 ? '' : 's') + ' done', autoSub: 'Repair' });
            items.push({ key: 'testing',   label: 'Testing passed',         autoSub: 'Testing' });
        }

        items.push({ key: 'ready',     label: 'Ready for pickup / shipping', autoStage: 'Ready' });
        items.push({ key: 'handed',    label: 'Handed over to customer',     autoStage: 'Completed' });

        return items;
    }

    // Current ticked items for an order.
    // Prefers the stored checklist_state; falls back to inference for legacy orders.
    function deriveTickedSteps(order) {
        var raw = order.checklist_state;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            // Only trust checklist_state if it has at least one key.
            // Empty {} means "never ticked" → fall back to inference.
            for (var k in raw) {
                if (raw.hasOwnProperty(k)) return raw;
            }
        }
        return inferTickedFromStage(order);
    }

    // Legacy inference — used only for orders that don't have checklist_state yet.
    function inferTickedFromStage(order) {
        var stage = order.progress_stage || 'Order Received';
        var sub = order.progress_substage || '';
        var ticked = {};
        if (stage === 'Order Received') return ticked;

        ticked.confirmed = true;
        if (stage === 'In Progress' || stage === 'Ready' || stage === 'Completed') {
            ticked.received = true;
        }

        if (stage === 'In Progress') {
            var list = getEffectiveSubStages(order);
            var idx = list.indexOf(sub);
            if (idx >= 0) {
                for (var i = 0; i <= idx; i++) {
                    var step = list[i];
                    if (step === 'Modchip Installation') ticked.modchip = true;
                    else if (step === 'Device Repair' || step === 'Repair') ticked.repair = true;
                    else if (step === 'Diagnosis') ticked.diagnosis = true;
                    else if (step === 'Testing') ticked.testing = true;
                    else if (step === 'System Setup') ticked.setup = true;
                    else if (step === 'Game Installation') ticked.games = true;
                }
            }
        } else if (stage === 'Ready') {
            ticked.modchip = true;
            ticked.repair = true;
            ticked.setup = true;
            ticked.games = true;
            ticked.diagnosis = true;
            ticked.testing = true;
            ticked.ready = true;
        } else if (stage === 'Completed') {
            ticked.modchip = true;
            ticked.repair = true;
            ticked.setup = true;
            ticked.games = true;
            ticked.diagnosis = true;
            ticked.testing = true;
            ticked.ready = true;
            ticked.handed = true;
        }
        return ticked;
    }

    function toggleChecklist(orderId) {
        expandedChecklists[String(orderId)] = !expandedChecklists[String(orderId)];
        filterAndRenderOrders();
    }

    async function toggleChecklistItem(orderId, stepKey) {
        var order = findOrder(orderId);
        if (!order) return;

        var checklist = buildChecklist(order);
        var ticked = deriveTickedSteps(order);
        var nowTicked = !ticked[stepKey];

        var newTicked = Object.assign({}, ticked);
        newTicked[stepKey] = nowTicked;

        var foundIdx = -1;
        for (var i = 0; i < checklist.length; i++) {
            if (checklist[i].key === stepKey) { foundIdx = i; break; }
        }
        if (foundIdx === -1) return;

        // No skipping: tick everything before, untick everything after
        if (nowTicked) {
            for (var k = 0; k < foundIdx; k++) newTicked[checklist[k].key] = true;
        } else {
            for (var j = foundIdx + 1; j < checklist.length; j++) {
                newTicked[checklist[j].key] = false;
            }
        }

        // Derive stage + substage from the furthest ticked item
        var newStage = 'Order Received';
        var newSub = null;
        for (var m = checklist.length - 1; m >= 0; m--) {
            var item = checklist[m];
            if (!newTicked[item.key]) continue;
            if (item.autoStage) { newStage = item.autoStage; break; }
            if (item.autoSub === 'Received') { newStage = 'Confirmed'; newSub = 'Received'; break; }
            if (item.autoSub) { newStage = 'In Progress'; newSub = item.autoSub; break; }
            if (newStage === 'Order Received') newStage = 'Confirmed';
        }

        var nowIso = new Date().toISOString();
        var payload = {
            checklist_state: newTicked,
            progress_stage: newStage,
            progress_substage: newSub,
            progress_updated_at: nowIso,
            status: STAGE_TO_STATUS[newStage] || 'Pending',
            updated_at: nowIso
        };
        var idField = order.id ? 'id' : 'order_id';
        var res = await supabaseClient.from('orders').update(payload).eq(idField, order.id || order.order_id);
        if (res.error) { alert('Failed to update: ' + res.error.message); return; }

        order.checklist_state = newTicked;
        order.progress_stage = newStage;
        order.progress_substage = newSub;
        order.progress_updated_at = nowIso;
        order.status = payload.status;
        order.updated_at = nowIso;

        updateStats();
        filterAndRenderOrders();
    }

    // ===== STATS =====
    function updateStats() {
        document.getElementById('statTotal').innerText = allOrders.length;

        var queue = 0, needs = 0, revenue = 0;
        allOrders.forEach(function(o) {
            var s = o.progress_stage || 'Order Received';
            var status = o.status || 'Pending';
            if (status === 'Cancelled') return;
            revenue += Number(o.estimated_price) || 0;
            if (s !== 'Completed' && s !== 'Cancelled') {
                needs++;
                // "In queue" = console received but no work started yet
                var ticked = deriveTickedSteps(o);
                var anyWorkTicked = ticked.modchip || ticked.diagnosis || ticked.repair || ticked.setup || ticked.games || ticked.testing;
                if (ticked.received && !anyWorkTicked && s !== 'Ready') queue++;
            }
        });
        document.getElementById('statQueue').innerText = queue;
        document.getElementById('statNeeds').innerText = needs;
        document.getElementById('statRevenue').innerText = 'RM' + Math.round(revenue);
    }

    function setStatusFilter(status, btn) {
        currentStatusFilter = status;
        document.querySelectorAll('.filter-btn[data-status]').forEach(function(b) { b.classList.remove('active'); });
        if (btn) btn.classList.add('active');
        filterAndRenderOrders();
    }
    function setCatalogFilter(filter, btn) {
        currentCatalogFilter = filter;
        document.querySelectorAll('.filter-btn[data-catfilter]').forEach(function(b) { b.classList.remove('active'); });
        if (btn) btn.classList.add('active');
        renderCatalog();
    }

    // ===== ORDER CARD =====
    function filterAndRenderOrders() {
        var input = document.getElementById('adminSearchInput');
        var query = input ? input.value.toLowerCase().trim() : '';
        var container = document.getElementById('ordersContainer');

        var filtered = [];
        for (var i = 0; i < allOrders.length; i++) {
            var order = allOrders[i];
            var stage = order.progress_stage || 'Order Received';
            var status = order.status || 'Pending';

            if (currentStatusFilter === 'NEEDS') {
                if (status === 'Cancelled' || status === 'Completed' || stage === 'Completed') continue;
            } else if (currentStatusFilter === 'QUEUED') {
                if (status === 'Cancelled' || status === 'Completed' || stage === 'Completed' || stage === 'Ready') continue;
                var _t = deriveTickedSteps(order);
                var _work = _t.modchip || _t.diagnosis || _t.repair || _t.setup || _t.games || _t.testing;
                if (!(_t.received && !_work)) continue;
            } else if (currentStatusFilter !== 'ALL') {
                if (currentStatusFilter === 'Pending') {
                    if (status !== 'Pending') continue;
                } else if (currentStatusFilter === 'In Progress') {
                    if (status !== 'In Progress') continue;
                } else if (currentStatusFilter === 'Ready') {
                    if (stage !== 'Ready') continue;
                } else if (currentStatusFilter !== status) {
                    continue;
                }
            }

            if (query) {
                var phoneMatch = order.phone_ending && order.phone_ending.toLowerCase().indexOf(query) !== -1;
                var waMatch = order.whatsapp_username && order.whatsapp_username.toLowerCase().indexOf(query) !== -1;
                var remarksMatch = order.remarks && order.remarks.toLowerCase().indexOf(query) !== -1;
                var stageMatch = stage.toLowerCase().indexOf(query) !== -1;
                var gameList = gameListOf(order);
                var gameMatch = false;
                for (var j = 0; j < gameList.length; j++) if (String(gameList[j]).toLowerCase().indexOf(query) !== -1) { gameMatch = true; break; }
                var repairList = getEnrichedRepairs(order);
                var repairMatch = false;
                for (var k = 0; k < repairList.length; k++) if (String(repairList[k].name).toLowerCase().indexOf(query) !== -1) { repairMatch = true; break; }
                if (!phoneMatch && !waMatch && !gameMatch && !remarksMatch && !stageMatch && !repairMatch) continue;
            }
            filtered.push(order);
        }

        if (filtered.length === 0) {
            container.innerHTML = '<div class="no-orders">' +
                (currentStatusFilter === 'NEEDS' ? 'No active work right now. &#127881;' : 'No orders match.') +
                '</div>';
            updateBulkBarUI();
            return;
        }

        container.innerHTML = '';
        for (var m = 0; m < filtered.length; m++) {
            (function(order) {
                container.appendChild(buildOrderCard(order));
            })(filtered[m]);
        }
        updateBulkBarUI();
    }

    function buildOrderCard(order) {
        var card = document.createElement('div');
        var orderId = order.id || order.order_id;
        var status = order.status || 'Pending';
        var stage = order.progress_stage || 'Order Received';
        var statusClass = status.replace(/\s+/g, '-');

        card.className = 'order-card status-' + statusClass;
        card.setAttribute('data-order-id', orderId);
        if (bulkSelectedIds[String(orderId)]) card.classList.add('selected-for-bulk');

        var gameList = gameListOf(order);
        var repairs = getEnrichedRepairs(order);
        var phoneCount = orderCountByPhone[order.phone_ending] || 1;
        var isChecked = bulkSelectedIds[String(orderId)] ? ' checked' : '';

        // Summary line
        var summaryParts = [];
        summaryParts.push(serviceLabel(order));
        // SD info (only for services that use one)
        if (order.service_type === 'jailbreak' || order.service_type === 'system_setup') {
            var sdSize = order.sd_card_size || 0;
            var sdSizeLabel = sdSize >= 1024 ? (sdSize / 1024).toFixed(0) + 'TB' : sdSize + 'GB';
            var sdSourceLabel = order.sd_source === 'buy' ? 'New SD' : 'Own SD';
            if (sdSize > 0) summaryParts.push(sdSourceLabel + ' <strong>' + sdSizeLabel + '</strong>');
        }
        if (order.service_type !== 'repair_only') summaryParts.push('<strong>' + gameList.length + '</strong> game' + (gameList.length === 1 ? '' : 's'));
        if (repairs.length > 0) summaryParts.push('<strong>' + repairs.length + '</strong> repair' + (repairs.length === 1 ? '' : 's'));
        var summaryLine = summaryParts.join(' <span class="muted">·</span> ');

        // Meta line
        var waDisplay = order.whatsapp_username
            ? '<span class="order-meta-wa">' + escapeHtml(order.whatsapp_username) + '</span>'
            : '<span class="order-meta-wa empty">No WA</span>';
        var dateStr = order.created_at ? new Date(order.created_at).toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
        var metaLine = waDisplay + '<span class="order-meta-sep">·</span>' + dateStr;
        if (phoneCount > 1) {
            metaLine += '<span class="order-meta-sep">·</span><span style="color:#ffb74d;">' + phoneCount + ' orders</span>';
        }

        // Checklist
        var checklist = buildChecklist(order);
        var ticked = deriveTickedSteps(order);
        var isExpanded = !!expandedChecklists[String(orderId)];
        var doneCount = 0;
        checklist.forEach(function(item) { if (ticked[item.key]) doneCount++; });

        // "In queue" — console is with us but no work item ticked yet
        var anyWorkTicked = ticked.modchip || ticked.diagnosis || ticked.repair || ticked.setup || ticked.games || ticked.testing;
        var isQueued = !!ticked.received && !anyWorkTicked && stage !== 'Ready' && stage !== 'Completed' && status !== 'Cancelled';

        var checklistHtml = '';
        var firstPendingSeen = false;
        checklist.forEach(function(item) {
            var isDone = !!ticked[item.key];
            var isCurrent = false;
            if (!isDone && !firstPendingSeen) { isCurrent = true; firstPendingSeen = true; }
            var cls = 'checklist-item' + (isDone ? ' done' : '') + (isCurrent ? ' current' : '');
            var badge = isDone ? 'Done' : (isCurrent ? 'Next' : '');
            var boxContent = isDone ? '&#10003;' : '';
            checklistHtml +=
                '<div class="' + cls + '" data-order-id="' + orderId + '" data-step="' + item.key + '">' +
                    '<div class="checklist-box">' + boxContent + '</div>' +
                    '<div class="checklist-name">' + escapeHtml(item.label) + '</div>' +
                    (badge ? '<div class="checklist-badge">' + badge + '</div>' : '') +
                '</div>';
        });

        var stagePillClass = stage.replace(/\s+/g, '-');
        var stageIcon = STAGE_ICONS[stage] || '';
        card.innerHTML =
            '<div class="card-select-wrap"><input type="checkbox" class="bulk-checkbox" data-order-id="' + orderId + '"' + isChecked + '></div>' +
            '<div class="order-card-header">' +
                '<div class="order-card-header-left">' +
                    '<div class="order-id-row">' +
                        '<span class="order-id">Order #' + escapeHtml(order.phone_ending || 'N/A') + '</span>' +
                        '<button class="order-copy-btn" data-order-id="' + orderId + '" title="Copy order number">Copy #</button>' +
                                                '<span class="stage-pill ' + stagePillClass + '">' + (stageIcon ? stageIcon + ' ' : '') + escapeHtml(stage) + '</span>' +
                                                (isQueued ? '<span class="stage-pill Queued">In queue</span>' : '') +
                    '</div>' +
                    '<div class="order-meta">' + metaLine + '</div>' +
                    '<div class="order-summary-line">' + summaryLine + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="checklist-toggle' + (isExpanded ? ' open' : '') + '" data-order-id="' + orderId + '">' +
                '<span>Work checklist</span>' +
                '<span class="progress-text">' + doneCount + '/' + checklist.length + ' done</span>' +
                '<span class="chev">▼</span>' +
            '</div>' +
            '<div class="checklist-body' + (isExpanded ? ' open' : '') + '">' + checklistHtml + '</div>' +
            '<div class="order-card-footer">' +
                '<div class="order-card-footer-left">' +
                    '<button class="view-btn" data-order-id="' + orderId + '" title="Open the full order details">Full Order</button>' +
                    '<a class="view-btn track-btn" href="' + buildTrackLink(order) + '" target="_blank" rel="noopener noreferrer" title="Open the customer tracking page in a new tab">Tracking</a>' +
                '</div>' +
                '<div class="order-card-footer-right">' +
                    '<button class="delete-btn" data-order-id="' + orderId + '">Delete</button>' +
                '</div>' +
            '</div>';

        return card;
    }

    function copyOrderNo(orderId, btnElement) {
        var order = findOrder(orderId);
        if (!order) return;
        var num = order.phone_ending || '';
        if (!num) return;
        navigator.clipboard.writeText(num).then(function() {
            var orig = btnElement.textContent;
            btnElement.textContent = 'Copied';
            btnElement.style.background = '#00e676';
            btnElement.style.color = '#14110a';
            btnElement.style.borderColor = '#00e676';
            setTimeout(function() {
                btnElement.textContent = orig;
                btnElement.style.background = '';
                btnElement.style.color = '';
                btnElement.style.borderColor = '';
            }, 1600);
        }).catch(function(err) { alert('Copy failed: ' + err); });
    }

    // ===== BULK =====
    function bulkCount() { var n = 0; for (var k in bulkSelectedIds) if (bulkSelectedIds.hasOwnProperty(k)) n++; return n; }
    function bulkKeys() { var arr = []; for (var k in bulkSelectedIds) if (bulkSelectedIds.hasOwnProperty(k)) arr.push(k); return arr; }

    function clearBulkSelection() {
        bulkSelectedIds = {};
        document.querySelectorAll('.bulk-checkbox').forEach(function(cb) {
            cb.checked = false;
            var card = cb.closest ? cb.closest('.order-card') : null;
            if (card) card.classList.remove('selected-for-bulk');
        });
        updateBulkBarUI();
    }

    function updateBulkBarUI() {
        var n = bulkCount();
        var bar = document.getElementById('bulkBar');
        if (bar) bar.style.display = n > 0 ? 'block' : 'none';
        document.getElementById('bulkCount').innerText = n;
        document.getElementById('bulkCountPlural').textContent = n === 1 ? '' : 's';
    }

    function bulkDeleteOrders() {
        var n = bulkCount();
        if (n === 0) return;
        var ids = bulkKeys();
        inlineConfirm({
            title: 'Delete Orders',
            message: 'Delete ' + n + ' order' + (n === 1 ? '' : 's') + '?\n\nThis cannot be undone.',
            confirmLabel: 'Delete All',
            onConfirm: function() {
                supabaseClient.from('orders').delete().in('id', ids).then(function(res) {
                    if (res.error) {
                        supabaseClient.from('orders').delete().in('order_id', ids).then(function(res2) {
                            if (res2.error) { alert('Bulk delete failed: ' + res2.error.message); return; }
                            clearBulkSelection(); loadOrders();
                        });
                        return;
                    }
                    clearBulkSelection(); loadOrders();
                });
            }
        });
    }

    function deleteOrder(orderId) {
        var order = findOrder(orderId);
        if (!order) return;
        var orderNum = order.phone_ending || '';
        inlineConfirm({
            title: 'Delete Order',
            message: 'Delete order #' + orderNum + '?\n\nThis cannot be undone.',
            confirmLabel: 'Delete',
            onConfirm: function() {
                var idField = order.id ? 'id' : 'order_id';
                supabaseClient.from('orders').delete().eq(idField, orderId).then(function(res) {
                    if (res.error) { alert('Delete failed: ' + res.error.message); return; }
                    allOrders = allOrders.filter(function(o) { return String(o.id) !== String(orderId) && String(o.order_id) !== String(orderId); });
                    delete bulkSelectedIds[String(orderId)];
                    updateStats();
                    filterAndRenderOrders();
                });
            }
        });
    }

    function deleteOrderFromModal() {
        if (!currentModalOrder) return;
        var order = currentModalOrder;
        var orderId = order.id || order.order_id;
        var orderNum = order.phone_ending || '';
        inlineConfirm({
            title: 'Delete Order',
            message: 'Delete order #' + orderNum + '?\n\nThis cannot be undone.',
            confirmLabel: 'Delete',
            onConfirm: function() {
                var idField = order.id ? 'id' : 'order_id';
                supabaseClient.from('orders').delete().eq(idField, order.id).then(function(res) {
                    if (res.error) { alert('Delete failed: ' + res.error.message); return; }
                    allOrders = allOrders.filter(function(o) { return String(o.id) !== String(orderId) && String(o.order_id) !== String(orderId); });
                    delete bulkSelectedIds[String(orderId)];
                    closeOrderModal();
                    updateStats();
                    filterAndRenderOrders();
                });
            }
        });
    }

    // ===== PRICE ADJUSTMENTS (free games + subtotal discount) =====
    var adjustState = { orderId: null, schemaOk: true };

    function el(id) { return document.getElementById(id); }

    /** True once the price adjustment columns exist on the orders table. */
    function detectAdjustSchema() {
        if (!allOrders || allOrders.length === 0) return true;
        var o = allOrders[0];
        return ('price_subtotal' in o) || ('discount_rm' in o) || ('free_games_count' in o);
    }

    function currentFreeGamesInput() {
        var v = parseInt(el('modalFreeGamesInput').value, 10);
        return (isFinite(v) && v > 0) ? v : 0;
    }
    function currentDiscountInput() {
        var v = parseFloat(el('modalDiscountInput').value);
        return (isFinite(v) && v > 0) ? Math.round(v) : 0;
    }

    /** Most games that can actually be waived on this order. */
    function freeGamesCeiling() {
        var order = findOrder(adjustState.orderId);
        if (!order) return 0;
        var isJbOrSetup = (order.service_type === 'jailbreak' || order.service_type === 'system_setup');
        return Math.max(0, gameListOf(order).length - (isJbOrSetup ? 3 : 0));
    }

    /**
     * Largest waiver that cannot raise the price.
     *
     * Game pricing is tiered (RM3.00 each up to 19 chargeable, RM2.50 up to 39),
     * so the tiers are NOT monotonic: waiving enough games can drop the count
     * into a pricier tier and *increase* the subtotal. "Give free games" must
     * never cost the customer more, so the ceiling is tightened to the highest
     * waiver that keeps the subtotal at or below the un-waived baseline.
     */
    function freeGamesSafeMax() {
        var order = findOrder(adjustState.orderId);
        if (!order) return 0;
        var ceiling = freeGamesCeiling();
        if (ceiling <= 0) return 0;
        var baseline = computePricing(pricingInputsForOrder(order, 0)).subtotal;
        // The tiers are non-monotonic (dropping into the RM3.00 tier can cost
        // more than the RM2.50 tier it left), so scan the whole range and keep
        // the highest waiver that still does not exceed the baseline.
        var safe = 0;
        for (var n = 1; n <= ceiling; n++) {
            if (computePricing(pricingInputsForOrder(order, n)).subtotal <= baseline) safe = n;
        }
        return safe;
    }

    function bumpFreeGames(delta) {
        var v = currentFreeGamesInput() + delta;
        if (v < 0) v = 0;
        // Clamp to the hard ceiling (chargeable games) only. Clamping to the
        // price-safe maximum as well would make "+" do nothing at all on
        // orders where every waiver is price-safe only at zero.
        var ceiling = freeGamesCeiling();
        if (v > ceiling) v = ceiling;
        el('modalFreeGamesInput').value = String(v);
        updateAdjustPreview();
    }

    function onAdjustInputChange() {
        // keep the discount field normalised (no stray decimals / negatives)
        el('modalDiscountInput').value = String(currentDiscountInput());
        updateAdjustPreview();
    }

    function setAdjustStatus(msg, kind) {
        var s = el('adjustSaveStatus');
        s.textContent = msg || '';
        s.className = 'adjust-save-status' + (kind ? ' ' + kind : '');
    }

    /**
     * Explain why a stored total disagrees with a fresh recalculation, in terms
     * that match the service the order is actually for. Mismatches come from
     * hand-set repair prices or, for non-repair work, from a tariff change
     * after the order was placed.
     */
    function mismatchReasonText(order, stored, baseline, dir) {
        var base = 'This order stores RM' + stored.subtotal + ' but recalculates to RM' + baseline +
            ' (' + dir + '). Saving will REPLACE the stored total with the recalculated one.';

        var repairs = getEnrichedRepairs(order);
        var priceableRepairs = repairs.filter(function (r) { return !r.isQuote && r.id !== 'diagnostic'; });

        if (priceableRepairs.length > 0) {
            return base + ' A repair price was most likely set by hand — check the repair prices in this order.';
        }
        if (order.service_type === 'repair_only') {
            return base + ' Check the service fee and any repair prices for this order.';
        }

        // A customer editing their own order can change the game count, which
        // changes the price. They are not allowed to update the stored total
        // themselves, so this mismatch is expected rather than suspicious.
        var created = Date.parse(order.created_at || '') || 0;
        var updated = Date.parse(order.updated_at || '') || 0;
        if (created && updated && (updated - created) > 60 * 1000) {
            return base + ' The customer has edited this order since it was placed, which may have ' +
                'changed the game count or storage size. Check their current selections before saving.';
        }

        return base + ' This usually means the price list changed after the order was placed. ' +
            'Check the game count and any add-ons before saving.';
    }

    function updateAdjustPreview() {
        var order = findOrder(adjustState.orderId);
        if (!order) return;

        var freeGames = currentFreeGamesInput();
        var discount = currentDiscountInput();
        var baseline = computePricing(pricingInputsForOrder(order, 0)).subtotal;
        var detail = computePricing(pricingInputsForOrder(order, freeGames));

        var subtotal = detail.subtotal;
        var appliedDiscount = Math.min(discount, subtotal);
        var total = Math.max(0, subtotal - appliedDiscount);

        // Waiving games pushed the subtotal above the un-waived baseline because
        // the count fell into a pricier per-game tier. Block the save rather
        // than silently charging the customer more for a "free games" discount.
        var wouldIncrease = subtotal > baseline;
        var increaseBy = subtotal - baseline;

        // The stored total may not equal a fresh recalculation, e.g. a repair
        // price was hand-set via "Set Price", or the order predates a tariff
        // change. Saving would silently overwrite it, so make the admin confirm.
        var stored = getOrderTotals(order);
        var mismatchBy = baseline - stored.subtotal;
        var mismatch = mismatchBy !== 0;

        el('adjustSubtotalVal').textContent = 'RM' + subtotal;
        el('adjustTotalVal').textContent = 'RM' + total;

        if (appliedDiscount > 0) {
            el('adjustDiscountRow').style.display = 'flex';
            el('adjustDiscountVal').textContent = '−RM' + appliedDiscount;
            el('adjustDiscountLabel').textContent = (appliedDiscount < discount)
                ? 'Discount (capped at subtotal)'
                : 'Discount';
        } else {
            el('adjustDiscountRow').style.display = 'none';
        }

        // --- warnings ---
        el('adjustSchemaNote').classList.toggle('show', !adjustState.schemaOk);
        // (the "nothing to waive" case is handled in the stepper-bounds block below)
        el('adjustVolumeNote').classList.toggle('show', !!detail.freeGamesNoEffect);
        el('adjustClampNote').classList.toggle('show', detail.freeGamesUnused > 0);
        if (detail.freeGamesUnused > 0) {
            el('adjustClampText').textContent = detail.freeGamesUnused +
                ' of the free games exceed the chargeable count and will be ignored.';
        }
        el('adjustIncreaseNote').classList.toggle('show', wouldIncrease);
        el('adjustMismatchNote').classList.toggle('show', mismatch && !wouldIncrease);
        if (mismatch && !wouldIncrease) {
            var dir = mismatchBy > 0 ? 'RM' + mismatchBy + ' lower' : 'RM' + (-mismatchBy) + ' higher';
            el('adjustMismatchText').textContent = mismatchReasonText(order, stored, baseline, dir);
        }
        if (wouldIncrease) {
            // Recommend the nearest waiver below the current value that is safe.
            var suggestion = 0;
            for (var n = 1; n < freeGames; n++) {
                if (computePricing(pricingInputsForOrder(order, n)).subtotal <= baseline) suggestion = n;
            }
            el('adjustIncreaseText').textContent =
                'Giving ' + freeGames + ' free game' + (freeGames === 1 ? '' : 's') +
                ' would INCREASE the subtotal by RM' + increaseBy +
                ' because the lower count falls into a pricier per-game tier. ' +
                (suggestion > 0
                    ? 'Use ' + suggestion + ' or fewer free games, or apply an RM discount instead.'
                    : 'Use no free games, or apply an RM discount instead.');
        }

        // --- stepper bounds ---
        var ceiling = freeGamesCeiling();

        // "+" stays live whenever the chargeable count allows more, so the
        // control never feels dead on arrival. The price-safe cap is enforced
        // on save (and explained by adjustIncreaseNote) rather than by
        // silently refusing to increment.
        el('freeGamesMinus').disabled = (freeGames <= 0);
        el('freeGamesPlus').disabled = (freeGames >= ceiling);

        // Explain a dead stepper instead of leaving it looking broken.
        var gameCount = gameListOf(order).length;
        var isJbOrSetup = (order.service_type === 'jailbreak' || order.service_type === 'system_setup');
        var noWaivable = el('adjustNoGamesNote');
        if (ceiling === 0) {
            noWaivable.classList.add('show');
            if (gameCount === 0) {
                el('adjustNoGamesText').textContent =
                    'This order has no games, so there is nothing to waive. Use the RM discount instead.';
            } else {
                el('adjustNoGamesText').textContent =
                    'All ' + gameCount + ' game' + (gameCount === 1 ? '' : 's') +
                    ' on this order are already included in the package' +
                    (isJbOrSetup ? ' (first 3 are free)' : '') +
                    ', so there is nothing left to waive. Use the RM discount instead.';
            }
            el('freeGamesHint').textContent = 'No chargeable games to waive';
        } else {
            noWaivable.classList.remove('show');
            // Show the real ceiling so the cap is never a mystery.
            el('freeGamesHint').textContent = 'Waived from the chargeable count (max ' + ceiling + ')';
        }

        el('adjustSaveBtn').disabled = !adjustState.schemaOk || wouldIncrease;
        el('adjustClearBtn').disabled = !adjustState.schemaOk;

        // keep the summary row at the top of the modal in sync
        var priceVal = el('modalPriceVal');
        if (priceVal) {
            priceVal.textContent = 'RM' + total + (appliedDiscount > 0 ? ' (was RM' + subtotal + ')' : '');
        }
    }

    function renderPriceAdjustments(order) {
        adjustState.orderId = order ? (order.id || order.order_id) : null;
        adjustState.schemaOk = detectAdjustSchema();
        var totals = getOrderTotals(order || {});
        el('modalFreeGamesInput').value = String(totals.freeGames);
        el('modalDiscountInput').value = String(totals.discount);
        setAdjustStatus('');
        updateAdjustPreview();
    }

    function clearPriceAdjustments() {
        el('modalFreeGamesInput').value = '0';
        el('modalDiscountInput').value = '0';
        updateAdjustPreview();
        setAdjustStatus('');
    }

    function resetPriceAdjustments() {
        var order = findOrder(adjustState.orderId);
        if (!order) return;
        var totals = getOrderTotals(order);
        el('modalFreeGamesInput').value = String(totals.freeGames);
        el('modalDiscountInput').value = String(totals.discount);
        updateAdjustPreview();
        setAdjustStatus('');
    }

    function savePriceAdjustments() {
        var order = findOrder(adjustState.orderId);
        if (!order) return;
        if (!adjustState.schemaOk) {
            setAdjustStatus('Database columns missing. Run the SQL migration first.', 'err');
            return;
        }

        var freeGames = currentFreeGamesInput();
        var discount = currentDiscountInput();
        var detail = computePricing(pricingInputsForOrder(order, freeGames));
        var subtotal = detail.subtotal;
        var appliedDiscount = Math.min(discount, subtotal);
        var total = Math.max(0, subtotal - appliedDiscount);

        var btn = el('adjustSaveBtn');
        btn.disabled = true;
        setAdjustStatus('Saving…');

        var baselineNow = computePricing(pricingInputsForOrder(order, 0)).subtotal;
        if (subtotal > baselineNow) {
            // Restore the button: leaving it disabled here makes Save look
            // permanently broken until the admin edits another field.
            btn.disabled = false;
            setAdjustStatus('Refused: these free games would raise the subtotal. Reduce the count first.', 'err');
            return;
        }

        // Overwriting a stored total that disagrees with the recalculation is
        // destructive and silent. Require an explicit confirmation.
        var storedNow = getOrderTotals(order);
        if (baselineNow !== storedNow.subtotal) {
            var diff = baselineNow - storedNow.subtotal;
            var dirNow = diff > 0 ? 'RM' + diff + ' higher' : 'RM' + (-diff) + ' lower';
            var msg = mismatchReasonText(order, storedNow, baselineNow, dirNow) + '\n\nSave anyway?';
            if (!confirm(msg)) {
                btn.disabled = false;
                setAdjustStatus('Cancelled. Stored total left unchanged.', 'err');
                return;
            }
        }

        var orderId = order.id || order.order_id;
        var idField = order.id ? 'id' : 'order_id';
        var nowIso = new Date().toISOString();

        // Persist the waiver count that was actually applied, not the number
        // that was typed in. On a 4-game jailbreak order only 1 game is
        // chargeable, so requesting 3 applies 1 and ignores 2 — storing the
        // requested number would tell the customer they got 3 free games when
        // they got 1. computePricing already clamps for us.
        var appliedFreeGames = detail.freeGamesApplied;
        var clampNote = appliedFreeGames < freeGames
            ? ' Only ' + appliedFreeGames + ' of the ' + freeGames + ' free games could be applied' +
              ' (the rest are already included in the package).'
            : '';

        var payload = {
            price_subtotal: subtotal,
            discount_rm: appliedDiscount,
            free_games_count: appliedFreeGames,
            estimated_price: total,
            updated_at: nowIso
        };

        supabaseClient.from('orders').update(payload).eq(idField, orderId).then(function(res) {
            btn.disabled = false;
            if (res.error) {
                setAdjustStatus('Failed: ' + res.error.message, 'err');
                return;
            }
            var local = findOrder(orderId);
            if (local) {
                local.price_subtotal = subtotal;
                local.discount_rm = appliedDiscount;
                local.free_games_count = appliedFreeGames;
                local.estimated_price = total;
                local.updated_at = nowIso;
            }
            adjustState.schemaOk = true;
            updateAdjustPreview();
            // Reflect the applied waiver back into the stepper, so reopening the
            // modal shows what was actually granted rather than what was typed.
            el('modalFreeGamesInput').value = String(appliedFreeGames);
            setAdjustStatus('Saved. Customer total is now RM' + total + '.' + clampNote, 'ok');
            updateStats();
            filterAndRenderOrders();
        }).catch(function(err) {
            btn.disabled = false;
            setAdjustStatus('Failed: ' + (err && err.message ? err.message : String(err)), 'err');
        });
    }

// ===== ORDER EDITOR =====
    //
    // Full editor for an order's contents and price. It exists because the only
    // other route is the customer's private link, and save_order never writes the
    // price columns - so editing through that route always leaves the total
    // describing the OLD selection. The admin is authenticated, so writing the
    // selection and the price together is safe here, and this is the one place
    // that can legitimately reprice an order already past "Order Received".
    var orderEdit = {
        orderId: null,
        serviceType: '',
        consoleModel: '',
        sdSource: '',
        sdSize: 0,
        android: false,
        linux: false,
        freeStorage: 0,
        games: [],
        repairs: {},
        lastRepairModel: ''
    };

    /**
     * True for the two services that store a console model, matching index.html:
     * jailbreak needs it, and repair-only needs it because per-model repair prices
     * cannot be quoted without it. System Setup never prices off the model.
     */
    function editNeedsModel() {
        return orderEdit.serviceType === 'jailbreak' || orderEdit.serviceType === 'repair_only';
    }

    /** Console picker with a genuine "not chosen yet" option. */
    var EDIT_CONSOLE_OPTIONS = [{ value: '', label: '— Select console —' }].concat(CONSOLE_OPTIONS);

    var _editGameSizes = null;
    /** name -> GB, built once from the shared catalogue. */
    function editGameSizes() {
        if (_editGameSizes) return _editGameSizes;
        _editGameSizes = {};
        ((typeof games !== 'undefined' && Array.isArray(games)) ? games : []).forEach(function (g) {
            _editGameSizes[g.name] = Number(g.size) || 0;
        });
        return _editGameSizes;
    }

    function editGameTotalGb() {
        var sizes = editGameSizes();
        return orderEdit.games.reduce(function (sum, n) { return sum + (sizes[n] || 0); }, 0);
    }

    /**
     * Installed footprint of the games on this order. Same rule as index.html:
     * buffer each game, then sum, so the fit checks here match what the customer
     * was shown. editGameTotalGb() stays the raw figure that is priced and stored.
     */
    function editGameFootprint() {
        var sizes = editGameSizes();
        return orderEdit.games.reduce(function (sum, n) {
            return sum + effectiveGb(sizes[n] || 0);
        }, 0);
    }

    function fillEditSelect(select, options, value) {
        select.innerHTML = '';
        options.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            select.appendChild(opt);
        });
        if (value != null && options.some(function (o) { return o.value === value; })) select.value = value;
    }

    function startOrderEdit() {
        var order = findOrder(currentModalOrderId);
        if (!order) return;

        orderEdit.orderId = currentModalOrderId;
        orderEdit.serviceType = order.service_type || 'jailbreak';
        // No fallback to OLED. A blank model has to read as "not chosen yet" so the
        // editor asks for it, rather than quietly pricing every repair at OLED rates.
        orderEdit.consoleModel = order.console_model || '';
        orderEdit.sdSource = order.sd_source || 'own';
        orderEdit.sdSize = Number(order.sd_card_size) || 0;
        orderEdit.android = !!order.android_mode;
        orderEdit.linux = !!order.linux_mode;
        orderEdit.freeStorage = Number(order.free_storage_gb) || 0;
        orderEdit.games = gameListOf(order);
        sortGameList(orderEdit.games);
        orderEdit.repairs = {};
        orderEdit.lastRepairModel = orderEdit.consoleModel;
        getEnrichedRepairs(order).forEach(function (r) { orderEdit.repairs[r.id] = r; });

        fillEditSelect(el('oeService'), SERVICE_OPTIONS, orderEdit.serviceType);
        fillEditSelect(el('oeConsole'), EDIT_CONSOLE_OPTIONS, orderEdit.consoleModel);
        fillEditSelect(el('oeSdSource'), SD_SOURCE_OPTIONS, orderEdit.sdSource);
        rebuildEditSdSizes(orderEdit.sdSize);
        el('oeAndroid').checked = orderEdit.android;
        el('oeLinux').checked = orderEdit.linux;
        el('oeFreeStorage').value = orderEdit.freeStorage > 0 ? String(orderEdit.freeStorage) : '';
        el('oeGameSearch').value = '';
        el('oeStatus').className = 'oe-status';
        el('oeStatus').textContent = '';

        // Delegation, re-bound each time so there is nothing to leak.
        el('oeGameOptions').onclick = function (ev) {
            var btn = ev.target.closest('.oe-opt');
            if (btn) addOrderEditGame(btn.getAttribute('data-name'));
        };
        el('oeSelectedGames').onclick = function (ev) {
            var btn = ev.target.closest('.oe-opt-remove');
            if (btn) removeOrderEditGame(btn.getAttribute('data-name'));
        };
        el('oeRepairList').onchange = function (ev) {
            var cb = ev.target.closest('.oe-repair input');
            if (cb) toggleOrderEditRepair(cb.getAttribute('data-id'), cb.checked);
        };

        renderEditRepairList();
        renderEditGameOptions();
        renderEditSelectedGames();

        el('orderReadOnlyService').style.display = 'none';
        el('modalEditOrderBtn').style.display = 'none';
        el('orderEditPanel').style.display = '';
        onOrderEditChange();
    }

    /** Put the modal back into read-only mode. */
    function resetOrderEditor() {
        if (!el('orderEditPanel')) return;
        el('orderEditPanel').style.display = 'none';
        el('orderReadOnlyService').style.display = '';
        el('modalEditOrderBtn').style.display = '';
        orderEdit.orderId = null;
    }

    function cancelOrderEdit() {
        resetOrderEditor();
    }

    /** Rebuild the card-size list for the chosen source, keeping the size in use. */
    function rebuildEditSdSizes(preferred) {
        var want = preferred != null ? Number(preferred) : (Number(orderEdit.sdSize) || 0);
        var opts = sdCardOptionsFor(orderEdit.sdSource);
        var sel = el('oeSdSize');
        fillEditSelect(sel, opts, null);

        var values = opts.map(function (o) { return Number(o.value); });
        if (want && values.indexOf(want) === -1) {
            // The stored size is not one we sell (legacy or hand-typed row). Snap up
            // to the next real card rather than leaving nothing selected.
            want = values.filter(function (v) { return v >= want; })[0] || values[values.length - 1];
        }
        if (want && values.indexOf(want) !== -1) sel.value = String(want);
        orderEdit.sdSize = sel.value ? Number(sel.value) : 0;
    }

    function onOrderEditSdSourceChange() {
        orderEdit.sdSource = el('oeSdSource').value;
        rebuildEditSdSizes(null);
        onOrderEditChange();
    }

    function onOrderEditChange() {
        orderEdit.serviceType = el('oeService').value;
        orderEdit.sdSize = el('oeSdSize').value ? Number(el('oeSdSize').value) : 0;
        orderEdit.android = el('oeAndroid').checked;
        orderEdit.linux = el('oeLinux').checked;
        var fs = parseFloat(el('oeFreeStorage').value);
        orderEdit.freeStorage = (isFinite(fs) && fs > 0) ? Math.round(fs) : 0;

        // Repair prices depend on the console model, so a model change has to
        // re-price whatever is already ticked. An empty model is not a price to
        // move to - repricing against it would zero every per-model repair - so the
        // last known prices stand and Save stays blocked until one is picked.
        var model = el('oeConsole').value;
        if (model !== orderEdit.lastRepairModel) {
            orderEdit.consoleModel = model;
            if (model) repriceEditRepairs(model);
            orderEdit.lastRepairModel = model;
            renderEditRepairList();
        }

        var svc = orderEdit.serviceType;
        var jb = isJbOrSetup(svc);
        var wantsFree = (svc === 'games_only' || svc === 'system_update');
        var needsModel = editNeedsModel();
        el('orderEditPanel').querySelectorAll('.oe-only-jb').forEach(function (n) { n.style.display = jb ? '' : 'none'; });
        el('orderEditPanel').querySelectorAll('.oe-only-model').forEach(function (n) { n.style.display = needsModel ? '' : 'none'; });
        el('orderEditPanel').querySelectorAll('.oe-only-free').forEach(function (n) { n.style.display = wantsFree ? '' : 'none'; });
        el('oeGamesBlock').style.display = (svc === 'repair_only') ? 'none' : '';

        // Repair Only means no games, and computePricing charges for games on any
        // service. Left alone, switching to it here would bill for a game list the
        // admin can no longer see, because the block above is hidden. Drop them,
        // but say so rather than silently losing the selection.
        if (svc === 'repair_only' && orderEdit.games.length) {
            var dropped = orderEdit.games.length;
            orderEdit.games = [];
            renderEditGameOptions();
            renderEditSelectedGames();
            var s = el('oeStatus');
            s.className = 'oe-status';
            s.textContent = 'Cleared ' + dropped + ' game' + (dropped === 1 ? '' : 's') +
                ' - Repair Only is a repair-only service. Switch the service back if that was not what you wanted.';
        }

        updateOrderEditPreview();
    }

    function repriceEditRepairs(model) {
        var catalogue = window.REPAIR_SERVICES || [];
        Object.keys(orderEdit.repairs).forEach(function (id) {
            var svc = catalogue.filter(function (s) { return s.id === id; })[0];
            if (!svc) return;
            var p = computeRepairPrice(svc, model || 'OLED');
            orderEdit.repairs[id].price = p.amount;
            orderEdit.repairs[id].isQuote = p.isQuote;
        });
    }

    function addOrderEditGame(name) {
        if (!name || orderEdit.games.indexOf(name) !== -1) return;
        orderEdit.games.push(name);
        sortGameList(orderEdit.games);
        renderEditGameOptions();
        renderEditSelectedGames();
        updateOrderEditPreview();
    }

    function removeOrderEditGame(name) {
        var i = orderEdit.games.indexOf(name);
        if (i === -1) return;
        orderEdit.games.splice(i, 1);
        renderEditGameOptions();
        renderEditSelectedGames();
        updateOrderEditPreview();
    }

    function renderEditGameOptions() {
        var box = el('oeGameOptions');
        var q = (el('oeGameSearch').value || '').trim().toLowerCase();
        var chosen = {};
        orderEdit.games.forEach(function (n) { chosen[n] = true; });

        var matches = ((typeof games !== 'undefined' && Array.isArray(games)) ? games : []).filter(function (g) {
            return !chosen[g.name] && (!q || g.name.toLowerCase().indexOf(q) !== -1);
        });
        // The library is 339 deep, which makes the box unusable on a phone, so cap
        // it and let the search box narrow things down.
        var capped = matches.length > 40;
        if (capped) matches = matches.slice(0, 40);

        if (matches.length === 0) {
            box.innerHTML = '<div class="oe-opt-empty">' +
                (q ? 'No game matches &ldquo;' + escapeHtml(q) + '&rdquo;.'
                   : 'Every game in the library is already on this order.') +
                '</div>';
            return;
        }
        var html = '';
        matches.forEach(function (g) {
            html += '<button type="button" class="oe-opt" data-name="' + escapeHtml(g.name) + '">' +
                    '<span class="oe-opt-name">' + escapeHtml(g.name) + '</span>' +
                    '<span class="oe-opt-size">' + effectiveGb(g.size) + ' GB</span></button>';
        });
        if (capped) html += '<div class="oe-opt-empty">' + matches.length +
                            ' shown &mdash; keep typing to narrow the list.</div>';
        box.innerHTML = html;
    }

    function renderEditSelectedGames() {
        var box = el('oeSelectedGames');
        var totalGb = editGameFootprint();
        el('oeSelectedGamesHead').innerHTML =
            'On this order (' + orderEdit.games.length + ' &middot; ' + totalGb.toFixed(1) + ' GB' + installBufferNote() + ')';

        if (orderEdit.games.length === 0) {
            box.innerHTML = '<div class="oe-opt-empty">No games on this order.</div>';
            return;
        }
        var sizes = editGameSizes();
        var html = '';
        orderEdit.games.forEach(function (name) {
            html += '<div class="oe-opt">' +
                    '<span class="oe-opt-name">' + escapeHtml(name) + '</span>' +
                    '<span class="oe-opt-size">' + (sizes[name] != null ? effectiveGb(sizes[name]) + ' GB' : 'size n/a') + '</span>' +
                    '<button type="button" class="oe-opt-remove" data-name="' + escapeHtml(name) +
                    '" aria-label="Remove ' + escapeHtml(name) + '">&times;</button></div>';
        });
        box.innerHTML = html;
    }

    function renderEditRepairList() {
        var box = el('oeRepairList');

        // A per-model repair price is unknowable without the model, so hold the
        // whole list back and say what is missing, rather than quoting an OLED
        // figure that may not apply to this console.
        if (editNeedsModel() && !orderEdit.consoleModel) {
            var waiting = Object.keys(orderEdit.repairs).length;
            box.innerHTML = '<div class="oe-opt-empty">Pick the console model above to see repair prices.' +
                (waiting ? ' ' + waiting + ' repair' + (waiting === 1 ? '' : 's') + ' on this order ' +
                           (waiting === 1 ? 'is' : 'are') + ' waiting to be priced.' : '') +
                '</div>';
            return;
        }

        var catalogue = window.REPAIR_SERVICES || [];
        var model = orderEdit.consoleModel || 'OLED';
        var inCatalogue = {};
        var html = '';
        catalogue.forEach(function (s) {
            inCatalogue[s.id] = true;
            var p = computeRepairPrice(s, model);
            var on = !!orderEdit.repairs[s.id];
            html += '<label class="oe-repair">' +
                    '<input type="checkbox" data-id="' + escapeHtml(s.id) + '"' + (on ? ' checked' : '') + '>' +
                    '<span class="oe-repair-name">' + escapeHtml(s.name) + '</span>' +
                    '<span class="oe-repair-price' + (p.isQuote ? ' quote' : '') + '">' +
                    (p.isQuote ? 'TBC' : 'RM' + p.amount) + '</span></label>';
        });

        // A repair that has been retired from the catalogue, or was hand-added,
        // still belongs to this order. Show it here anyway, otherwise it is
        // invisible in the editor and impossible to untick.
        var orphans = Object.keys(orderEdit.repairs).filter(function (id) { return !inCatalogue[id]; });
        if (orphans.length) {
            html += '<div class="oe-opt-empty">No longer in the catalogue, but still on this order:</div>';
            orphans.forEach(function (id) {
                var r = orderEdit.repairs[id];
                html += '<label class="oe-repair">' +
                        '<input type="checkbox" data-id="' + escapeHtml(id) + '" checked>' +
                        '<span class="oe-repair-name">' + escapeHtml(r.name) + '</span>' +
                        '<span class="oe-repair-price' + (r.isQuote ? ' quote' : '') + '">' +
                        (r.isQuote ? 'TBC' : 'RM' + r.price) + '</span></label>';
            });
        }
        if (!html) html = '<div class="oe-opt-empty">Repair catalogue not loaded.</div>';
        box.innerHTML = html;
    }

    function toggleOrderEditRepair(id, on) {
        if (on) {
            var svc = (window.REPAIR_SERVICES || []).filter(function (s) { return s.id === id; })[0];
            if (!svc) return;
            var p = computeRepairPrice(svc, orderEdit.consoleModel || 'OLED');
            orderEdit.repairs[id] = {
                id: svc.id, name: svc.name, category: svc.category || '',
                price: p.amount, isQuote: p.isQuote, note: svc.note || ''
            };
        } else {
            delete orderEdit.repairs[id];
        }
        // Re-render so a row removed above does not linger in the list.
        renderEditRepairList();
        updateOrderEditPreview();
    }

    /**
     * The editor state as an order-shaped object, so the preview and the save both
     * go through the same pricing path as the customer form.
     */
    function buildEditOrder() {
        var names = orderEdit.games.slice();
        var svc = orderEdit.serviceType;
        var jb = isJbOrSetup(svc);
        var wantsFree = (svc === 'games_only' || svc === 'system_update');
        return {
            service_type: svc,
            // Stored only where the model changes a price, same as index.html.
            console_model: editNeedsModel() ? orderEdit.consoleModel : '',
            sd_source: jb ? orderEdit.sdSource : '',
            sd_card_size: jb ? orderEdit.sdSize : null,
            // Only the services that fill existing space store this, same as index.html.
            free_storage_gb: (!jb && wantsFree && orderEdit.freeStorage > 0) ? orderEdit.freeStorage : null,
            android_mode: jb ? orderEdit.android : false,
            linux_mode: jb ? orderEdit.linux : false,
            games: names,
            total_games: names.length,
            total_size_gb: Math.round(editGameTotalGb() * 100) / 100,
            repairs: repairSnapshot(Object.keys(orderEdit.repairs).map(function (k) { return orderEdit.repairs[k]; }))
        };
    }

    /** Storage the games have to fit into. 0 when the service has no card. */
    function editStorageCapacity() {
        var svc = orderEdit.serviceType;
        if (isJbOrSetup(svc)) return orderEdit.sdSize;
        if (svc === 'games_only' || svc === 'system_update') return orderEdit.freeStorage;
        return 0;
    }

    function updateOrderEditPreview() {
        var pseudo = buildEditOrder();
        var freeGames = currentFreeGamesInput();
        var discount = currentDiscountInput();
        var baseline = computePricing(pricingInputsForOrder(pseudo, 0));
        var detail = computePricing(pricingInputsForOrder(pseudo, freeGames));
        var appliedDiscount = Math.min(discount, detail.subtotal);
        var total = Math.max(0, detail.subtotal - appliedDiscount);

        var html = '';
        html += '<div class="oe-preview-row"><span>Subtotal</span><span>RM' + detail.subtotal + '</span></div>';
        if (freeGames > 0) {
            html += '<div class="oe-preview-row"><span>Free games waived</span><span>' + detail.freeGamesApplied +
                    (detail.freeGamesApplied < freeGames ? ' of ' + freeGames : '') + '</span></div>';
        }
        if (appliedDiscount > 0) {
            html += '<div class="oe-preview-row"><span>Discount</span><span>&minus;RM' + appliedDiscount + '</span></div>';
        }
        html += '<div class="oe-preview-row total"><span>Total charged</span><span>RM' + total + '</span></div>';
        el('oePreview').innerHTML = html;

        // Capacity check. Warn, never trim: the shop may know something the numbers
        // do not, and silently dropping games would be worse than a warning.
        var cap = editStorageCapacity();
        // Fit is judged on the installed footprint, not the listed sizes, so the
        // warning matches the headroom the games will really need.
        var gb = editGameFootprint();
        var warnEl = el('oeGamesWarn');
        var over = cap > 0 && gb > cap;
        var tight = cap > 0 && !over && gb > 0 && (cap - gb) < 20;
        warnEl.style.display = (over || tight) ? '' : 'none';
        warnEl.className = 'oe-warn' + (over ? ' danger' : '');
        warnEl.textContent = over
            ? 'Games total ' + gb.toFixed(1) + ' GB' + installBufferNote() + ' but only ' + cap + ' GB is available. Trim the list or raise the size before saving.'
            : (tight ? 'Only ' + (cap - gb).toFixed(1) + ' GB spare. That is very tight for a card.' : '');

        // Same guard as Save Adjustments: game pricing is tiered, so a large
        // waiver can drop into a pricier tier and RAISE the total.
        var raises = detail.subtotal > baseline.subtotal;
        var noModel = editNeedsModel() && !orderEdit.consoleModel;
        el('oeSaveBtn').disabled = raises || noModel;
        var errEl = el('oeSaveError');
        errEl.style.display = (raises || noModel) ? '' : 'none';
        errEl.textContent = noModel
            ? 'Pick the console model before saving: repair prices depend on it.'
            : (raises
                ? 'Refused: the current free-games count would raise the price on this selection (game pricing is tiered). Reduce it in Price Adjustments first.'
                : '');
    }

    function saveOrderEdit() {
        var order = findOrder(orderEdit.orderId);
        if (!order) return;
        var btn = el('oeSaveBtn');
        var status = el('oeStatus');
        if (editNeedsModel() && !orderEdit.consoleModel) {
            status.className = 'oe-status err';
            status.textContent = 'Refused: pick the console model first, repair prices depend on it.';
            return;
        }
        var pseudo = buildEditOrder();

        var freeGames = currentFreeGamesInput();
        var discount = currentDiscountInput();
        var baseline = computePricing(pricingInputsForOrder(pseudo, 0));
        var detail = computePricing(pricingInputsForOrder(pseudo, freeGames));
        if (detail.subtotal > baseline.subtotal) {
            status.className = 'oe-status err';
            status.textContent = 'Refused: those free games would raise the price. Reduce the count first.';
            return;
        }
        var appliedDiscount = Math.min(discount, detail.subtotal);
        var total = Math.max(0, detail.subtotal - appliedDiscount);

        var cap = editStorageCapacity();
        var gbNeeded = editGameFootprint();
        var over = cap > 0 && gbNeeded > cap;
        var msg = 'Save these changes to order #' + (order.phone_ending || '?') + '?\n\n' +
                  'Games: ' + pseudo.total_games + ' (' + gbNeeded.toFixed(1) + ' GB' + installBufferNote() + ')\n' +
                  'New total: RM' + total;
        if (over) msg += '\n\nWARNING: the games do not fit in ' + cap + ' GB. Saving anyway.';
        if (!confirm(msg)) return;

        btn.disabled = true;
        status.className = 'oe-status';
        status.textContent = 'Saving...';

        var payload = {
            service_type: pseudo.service_type,
            console_model: pseudo.console_model,
            sd_source: pseudo.sd_source,
            sd_card_size: pseudo.sd_card_size,
            free_storage_gb: pseudo.free_storage_gb,
            android_mode: pseudo.android_mode,
            linux_mode: pseudo.linux_mode,
            games: pseudo.games,
            total_games: pseudo.total_games,
            total_size_gb: pseudo.total_size_gb,
            repairs: pseudo.repairs,
            price_subtotal: detail.subtotal,
            discount_rm: appliedDiscount,
            free_games_count: detail.freeGamesApplied,
            estimated_price: total,
            updated_at: new Date().toISOString()
        };

        var idField = order.id ? 'id' : 'order_id';
        supabaseClient.from('orders').update(payload).eq(idField, order.id || order.order_id).then(function (res) {
            btn.disabled = false;
            if (res.error) {
                status.className = 'oe-status err';
                status.textContent = 'Failed: ' + res.error.message;
                return;
            }
            // Keep the in-memory order in step, then re-render the whole modal from
            // it so the read-only rows, games, repairs and adjustments all agree.
            Object.keys(payload).forEach(function (k) { order[k] = payload[k]; });
            updateStats();
            filterAndRenderOrders();
            openOrderModal(orderEdit.orderId);
        }).catch(function (err) {
            btn.disabled = false;
            status.className = 'oe-status err';
            status.textContent = 'Failed: ' + (err && err.message ? err.message : String(err));
        });
    }

    // ===== FULL ORDER MODAL =====
    function openOrderModal(orderId) {
        var order = findOrder(orderId);
        if (!order) return;
        currentModalOrder = order;
        currentModalOrderId = orderId;
        currentRemarksOrderId = orderId;

        var stage = order.progress_stage || 'Order Received';
        var stagePillClass = stage.replace(/\s+/g, '-');

        document.getElementById('modalTitle').innerText = 'Order #' + (order.phone_ending || 'N/A');
        document.getElementById('modalStagePill').className = 'stage-pill ' + stagePillClass;
        document.getElementById('modalStagePill').innerText = (STAGE_ICONS[stage] ? STAGE_ICONS[stage] + ' ' : '') + stage;
        document.getElementById('modalPhoneVal').innerText = order.phone_ending || 'N/A';
        var waEl = document.getElementById('modalWaVal');
        waEl.innerText = order.whatsapp_username || 'Not assigned';
        waEl.className = 'val' + (order.whatsapp_username ? ' wa' : ' muted');
        var remarksEl = document.getElementById('modalRemarksVal');
        if (order.remarks && String(order.remarks).trim() !== '') {
            remarksEl.innerText = order.remarks;
            remarksEl.className = 'val';
        } else {
            remarksEl.innerText = 'None';
            remarksEl.className = 'val muted';
        }
        document.getElementById('modalServiceVal').innerText = serviceLabel(order);
                var sdSizeVal = order.sd_card_size || order.free_storage_gb || 0;
        var sdSizeLabel = sdSizeVal >= 1024 ? (sdSizeVal / 1024).toFixed(0) + ' TB' : sdSizeVal + ' GB';
        var needsSd = (order.service_type === 'jailbreak' || order.service_type === 'system_setup');
        var stVal = (order.sd_card_size || order.free_storage_gb || 0) + ' GB';
        if (order.service_type === 'system_update' && order.free_storage_gb) {
            stVal = order.free_storage_gb + ' GB (free space)';
        }
        document.getElementById('modalStorageVal').innerText = stVal;

        var sdSourceEl = document.getElementById('modalSdSourceVal');
        if (needsSd && order.sd_source) {
            sdSourceEl.innerText = order.sd_source === 'buy' ? 'Purchase New SD Card' : 'Bring Own SD Card';
            sdSourceEl.className = 'val' + (order.sd_source === 'buy' ? ' wa' : '');
        } else {
            sdSourceEl.innerText = '—';
            sdSourceEl.className = 'val muted';
        }
        var totalsRow = getOrderTotals(order);
        document.getElementById('modalPriceVal').innerText = 'RM' + totalsRow.total +
            (totalsRow.hasDiscount ? ' (was RM' + totalsRow.subtotal + ')' : '');
        document.getElementById('modalDateVal').innerText = order.created_at ? new Date(order.created_at).toLocaleString() : 'N/A';
        var lastUpdated = order.progress_updated_at || order.updated_at || order.created_at;
        document.getElementById('modalUpdatedVal').innerText = lastUpdated ? new Date(lastUpdated).toLocaleString() : 'N/A';

        document.getElementById('modalEditWaBtn').onclick = function() { editWhatsappUsername(orderId); };
        document.getElementById('modalEditRemarksBtn').onclick = function() { openRemarksModal(orderId); };

        // Customer links. Rendered from the order's own token, so a stale
        // currentModalOrder can never leak into the next modal.
        renderModalLinks(order);

        // Repairs
        renderModalRepairs(order);

        // Always reopen in read-only mode: after a save the editor would otherwise
        // stay open showing the state it just left, with no Edit Details button to
        // get back to.
        resetOrderEditor();

        // Games
        renderModalGames(order);

        // Shipping
        renderModalShipping(order);

        // Price adjustments (free games + discount)
        renderPriceAdjustments(order);

        // Notify button state
        var notifyBtn = document.getElementById('modalNotifyBtn');
        notifyBtn.disabled = !order.whatsapp_username;

        document.getElementById('orderModalOverlay').style.display = 'flex';
        lockBodyScroll();
    }

    function closeOrderModal() {
        document.getElementById('orderModalOverlay').style.display = 'none';
        currentModalOrderId = null;
        currentModalOrder = null;
        unlockBodyScroll();
    }
    function closeModalOnBackdrop(event) {
        if (event.target.id === 'orderModalOverlay') closeOrderModal();
    }

    function renderModalRepairs(order) {
        var container = document.getElementById('modalRepairsContainer');
        var repairs = getEnrichedRepairs(order);
        if (repairs.length === 0) { container.innerHTML = ''; return; }

        var sum = sumRepairs(repairs);
        var html = '<div class="modal-section">';
        html += '<div class="modal-section-title"><span>Repairs (' + repairs.length + (sum.quoteCount > 0 ? ' · ' + sum.quoteCount + ' quote' : '') + ')</span></div>';
        repairs.forEach(function(r) {
            html += '<div class="modal-repair-item">';
            html += '<div class="modal-repair-info">';
            html += '<div class="modal-repair-name">' + escapeHtml(r.name) + '</div>';
            if (r.note) html += '<div class="modal-repair-note">' + escapeHtml(r.note) + '</div>';
            html += '</div>';
            html += '<div class="modal-repair-right">';
            if (r.isQuote) {
                html += '<div class="modal-repair-price quote">TBC</div>';
                html += '<button class="set-price-btn" onclick="setRepairPrice(\'' + escapeHtml(r.id) + '\')">Set Price</button>';
            } else {
                html += '<div class="modal-repair-price">RM' + r.price + '</div>';
            }
            html += '</div>';
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    function renderModalGames(order) {
        var grid = document.getElementById('modalGameGrid');
        var gameList = gameListOf(order);
        sortGameList(gameList);
        var sourceGames = typeof games !== 'undefined' ? games : [];
        var sizeMap = {};
        sourceGames.forEach(function(g) { sizeMap[g.name] = g.size; });

        document.getElementById('modalGameCount').textContent = '(' + gameList.length + ')';
        grid.innerHTML = '';
        if (gameList.length === 0) {
            grid.innerHTML = '<div style="color:#6a6357; padding:10px; font-style:italic;">No games selected.</div>';
            return;
        }
        gameList.forEach(function(name, idx) {
            var item = document.createElement('div');
            item.className = 'modal-game-item';
            var size = sizeMap[name] ? effectiveGb(sizeMap[name]) + ' GB' : '';
            item.innerHTML = '<span class="modal-game-num">' + (idx + 1) + '</span><span class="modal-game-name">' + escapeHtml(name) + '</span>' + (size ? '<span class="modal-game-size">' + size + '</span>' : '');
            grid.appendChild(item);
        });
    }

    function renderModalShipping(order) {
        ['in', 'out'].forEach(function(dir) {
            var sel = document.getElementById('modalShip' + (dir === 'in' ? 'In' : 'Out') + 'Select');
            var input = document.getElementById('modalShip' + (dir === 'in' ? 'In' : 'Out') + 'Input');
            var clearBtn = document.getElementById('modalShip' + (dir === 'in' ? 'In' : 'Out') + 'ClearBtn');
            var courierKey = dir === 'in' ? order.tracking_inbound_courier : order.tracking_outbound_courier;
            var number = dir === 'in' ? order.tracking_inbound_number : order.tracking_outbound_number;

            sel.innerHTML = '<option value="">— Courier —</option>';
            Object.keys(COURIERS).forEach(function(key) {
                var o = document.createElement('option');
                o.value = key;
                o.textContent = COURIERS[key].label;
                if (key === courierKey) o.selected = true;
                sel.appendChild(o);
            });
            input.value = number || '';
            clearBtn.style.display = number ? 'inline-flex' : 'none';
        });
    }

    async function saveShipping(direction) {
        if (!currentModalOrder) return;
        var order = currentModalOrder;
        var prefix = direction === 'inbound' ? 'In' : 'Out';
        var courierKey = document.getElementById('modalShip' + prefix + 'Select').value;
        var number = document.getElementById('modalShip' + prefix + 'Input').value.trim();

        if (number && !courierKey) { alert('Please select a courier.'); return; }
        if (courierKey && !number) { alert('Please enter a tracking number.'); return; }

        var payload = {};
        if (direction === 'inbound') {
            payload.tracking_inbound_courier = courierKey || null;
            payload.tracking_inbound_number = number || null;
        } else {
            payload.tracking_outbound_courier = courierKey || null;
            payload.tracking_outbound_number = number || null;
        }
        var idField = order.id ? 'id' : 'order_id';
        var res = await supabaseClient.from('orders').update(payload).eq(idField, order.id || order.order_id);
        if (res.error) { alert('Failed: ' + res.error.message); return; }

        if (direction === 'inbound') {
            order.tracking_inbound_courier = courierKey || null;
            order.tracking_inbound_number = number || null;
        } else {
            order.tracking_outbound_courier = courierKey || null;
            order.tracking_outbound_number = number || null;
        }
        document.getElementById('modalShip' + prefix + 'ClearBtn').style.display = number ? 'inline-flex' : 'none';
        alert('Saved.');
    }

    function clearShipping(direction) {
        if (!currentModalOrder) return;
        var order = currentModalOrder;
        inlineConfirm({
            title: 'Clear Tracking',
            message: 'Clear ' + direction + ' tracking for this order?',
            confirmLabel: 'Clear',
            onConfirm: function() {
                var payload = {};
                if (direction === 'inbound') {
                    payload.tracking_inbound_courier = null;
                    payload.tracking_inbound_number = null;
                } else {
                    payload.tracking_outbound_courier = null;
                    payload.tracking_outbound_number = null;
                }
                var idField = order.id ? 'id' : 'order_id';
                supabaseClient.from('orders').update(payload).eq(idField, order.id || order.order_id).then(function(res) {
                    if (res.error) { alert('Failed: ' + res.error.message); return; }
                    if (direction === 'inbound') {
                        order.tracking_inbound_courier = null;
                        order.tracking_inbound_number = null;
                    } else {
                        order.tracking_outbound_courier = null;
                        order.tracking_outbound_number = null;
                    }
                    renderModalShipping(order);
                });
            }
        });
    }

    function copyGamesFromModal(btn) {
        var order = currentModalOrder;
        if (!order) return;
        var gameList = gameListOf(order);
        if (gameList.length === 0) { alert('No games to copy.'); return; }
        sortGameList(gameList);
        navigator.clipboard.writeText(gameList.join('\n')).then(function() {
            var orig = btn.textContent;
            btn.textContent = 'Copied';
            btn.style.background = '#ffc000';
            btn.style.color = '#14110a';
            btn.style.borderColor = '#ffc000';
            setTimeout(function() { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }, 1600);
        });
    }

    function copyModalOrderNo() {
        if (!currentModalOrder) return;
        var num = currentModalOrder.phone_ending || '';
        navigator.clipboard.writeText(num).then(function() { alert('Order number copied.'); });
    }

    function setRepairPrice(repairId) {
        if (!currentModalOrder) return;
        var order = currentModalOrder;
        var repairs = (Array.isArray(order.repairs) ? order.repairs : []).map(function(r) {
            return (r && typeof r === 'object')
                ? { id: r.id, name: r.name, category: r.category || '', price: r.price, is_quote: r.is_quote, note: r.note || '' }
                : r;
        });
        var idx = -1;
        for (var i = 0; i < repairs.length; i++) {
            if (repairs[i] && typeof repairs[i] === 'object' && repairs[i].id === repairId) { idx = i; break; }
        }
        if (idx === -1) { alert('Repair not found.'); return; }
        var existing = repairs[idx];

        openInlinePrompt({
            title: 'Set Repair Price',
            label: existing.name + ' — amount in RM:',
            value: existing.price ? String(existing.price) : '',
            placeholder: 'e.g. 350',
            inputmode: 'numeric',
            onSave: function(input) {
                if (input === null) return;
                var price = parseFloat(input);
                if (isNaN(price) || price < 0) { alert('Please enter a valid non-negative number.'); return; }

                repairs[idx] = { id: existing.id, name: existing.name, category: existing.category || '', price: price, is_quote: false, note: existing.note || '' };
                // Adjust by the delta only. Adding the full price again would inflate the
                // total every time a repair price is edited.
                var oldPrice = Number(existing.price) || 0;
                var delta = price - oldPrice;

                var patch = { repairs: repairs, updated_at: new Date().toISOString() };
                if (delta !== 0) patch.estimated_price = Math.max(0, (Number(order.estimated_price) || 0) + delta);

                var idField = order.id ? 'id' : 'order_id';
                supabaseClient.from('orders').update(patch).eq(idField, order.id || order.order_id).then(function(res) {
                    if (res.error) { alert('Failed: ' + res.error.message); return; }
                    order.repairs = repairs;
                    if (patch.estimated_price !== undefined) order.estimated_price = patch.estimated_price;
                    if (currentModalOrder) renderPriceAdjustments(currentModalOrder);
                    renderModalRepairs(order);
                    filterAndRenderOrders();
                    updateStats();
                });
            }
        });
    }

    function notifyCustomerFromModal() {
        if (!currentModalOrder) return;
        notifyCustomer(currentModalOrder.id || currentModalOrder.order_id);
    }

    function notifyCustomer(orderId) {
        var order = findOrder(orderId);
        if (!order) return;
        var waUsername = (order.whatsapp_username || '').trim();
        if (!waUsername) {
            inlineConfirm({
                title: 'No WhatsApp',
                message: 'This order has no WhatsApp saved.\n\nClick "Edit WhatsApp" first to add a contact.',
                confirmLabel: 'OK'
            });
            return;
        }

        var stage = order.progress_stage || 'Order Received';
        var sub = order.progress_substage;
        var repairs = getEnrichedRepairs(order);
        var msg = 'Hi! Quick update on your order (#' + (order.phone_ending || '') + ').\n\n';
        msg += 'Current stage: ' + stage + '\n';
        if (sub) msg += 'Substage: ' + sub + '\n';
        if (repairs.length > 0) {
            msg += '\nRepairs (' + repairs.length + '):\n';
            repairs.forEach(function(r) { msg += '• ' + r.name + ' — ' + (r.isQuote ? 'TBC' : 'RM' + r.price) + '\n'; });
        }
        var trackLines = [];
        if (order.tracking_inbound_number) {
            var cin = COURIERS[order.tracking_inbound_courier] || COURIERS['other'];
            trackLines.push('• Inbound (' + cin.label + '): ' + order.tracking_inbound_number);
        }
        if (order.tracking_outbound_number) {
            var cout = COURIERS[order.tracking_outbound_courier] || COURIERS['other'];
            trackLines.push('• Outbound (' + cout.label + '): ' + order.tracking_outbound_number);
        }
        if (trackLines.length > 0) msg += '\nParcel Tracking:\n' + trackLines.join('\n') + '\n';
        msg += '\nTrack live here: ' + (buildTrackingUrl(order) || 'message us and we will look it up');
        msg += '\n\nYour private link — keep this, it is the only way to view or change your order:\n'
            + (buildEditUrl(order) || 'message us and we will send you one');

        var encoded = encodeURIComponent(msg);
        var digitsOnly = waUsername.replace(/[^\d]/g, '');
        var waUrl;
        if (digitsOnly.length >= 8) {
            var intl = digitsOnly;
            if (intl.charAt(0) === '0') intl = '60' + intl.slice(1);
            waUrl = 'https://wa.me/' + intl + '?text=' + encoded;
        } else {
            waUrl = 'https://wa.me/?text=' + encoded;
        }
        window.open(waUrl, '_blank');
    }

    // Full absolute private link, for pasting into a message.
    function buildTrackingUrl(order) {
        var token = order && order.public_token;
        if (!token) return '';
        return window.location.origin + window.location.pathname.replace('admin.html', 'track.html')
            + '?t=' + encodeURIComponent(token);
    }

    // Same link, but for the order form rather than the tracker.
    function buildEditUrl(order) {
        var token = order && order.public_token;
        if (!token) return '';
        return window.location.origin + window.location.pathname.replace('admin.html', 'index.html')
            + '?t=' + encodeURIComponent(token);
    }

    // Customers can only open an order through its private token. The id is a
    // sequential integer and is not a secret, so it is never used in a link.
    function buildTrackLink(order) {
        var token = order && order.public_token;
        if (!token) return 'track.html';
        return 'track.html?t=' + encodeURIComponent(token);
    }

    function buildOrderLink(order) {
        var token = order && order.public_token;
        if (!token) return 'index.html';
        return 'index.html?t=' + encodeURIComponent(token);
    }

    function editWhatsappUsername(orderId) {
        var order = findOrder(orderId);
        if (!order) return;
        openInlinePrompt({
            title: 'Edit WhatsApp',
            label: 'WhatsApp name or number:',
            value: order.whatsapp_username || '',
            placeholder: 'e.g. 60123456789',
            inputmode: 'tel',
            onSave: function(newWa) {
                if (newWa === null) return;
                var trimmed = newWa.trim();
                var idField = order.id ? 'id' : 'order_id';
                supabaseClient.from('orders').update({ whatsapp_username: trimmed }).eq(idField, orderId).then(function(res) {
                if (res.error) { alert('Failed: ' + res.error.message); return; }
                order.whatsapp_username = trimmed;
                var modalId = currentModalOrder ? (currentModalOrder.id || currentModalOrder.order_id) : null;
                if (modalId && String(modalId) === String(orderId)) {
                    var waEl = document.getElementById('modalWaVal');
                    if (waEl) {
                        waEl.innerText = trimmed || 'Not assigned';
                        waEl.className = 'val' + (trimmed ? ' wa' : ' muted');
                    }
                    var notifyBtn = document.getElementById('modalNotifyBtn');
                    if (notifyBtn) notifyBtn.disabled = !trimmed;
                }
                filterAndRenderOrders();
            });
            }
        });
    }

    // ===== REMARKS =====
    function openRemarksModal(orderId) {
        var order = findOrder(orderId);
        if (!order) return;
        currentRemarksOrderId = orderId;
        document.getElementById('remarksEditTextarea').value = order.remarks || '';
        document.getElementById('remarksModalOverlay').style.display = 'flex';
        setTimeout(function() { document.getElementById('remarksEditTextarea').focus(); }, 100);
        lockBodyScroll();
    }
    function closeRemarksModal() {
        document.getElementById('remarksModalOverlay').style.display = 'none';
        currentRemarksOrderId = null;
        unlockBodyScroll();
    }
    function closeRemarksModalOnBackdrop(e) { if (e.target.id === 'remarksModalOverlay') closeRemarksModal(); }
    function saveRemarksEdit() {
        if (!currentRemarksOrderId) return;
        var order = findOrder(currentRemarksOrderId);
        if (!order) return;
        var newRemarks = document.getElementById('remarksEditTextarea').value.trim();
        var idField = order.id ? 'id' : 'order_id';
        var btn = document.getElementById('saveRemarksBtn');
        btn.disabled = true; btn.innerText = 'Saving...';
        supabaseClient.from('orders').update({ remarks: newRemarks }).eq(idField, currentRemarksOrderId).then(function(res) {
            btn.disabled = false; btn.innerText = 'Save Remarks';
            if (res.error) { alert('Failed: ' + res.error.message); return; }
            order.remarks = newRemarks;
            closeRemarksModal();
            filterAndRenderOrders();
            if (currentModalOrder && String(currentModalOrder.id) === String(currentRemarksOrderId)) openOrderModal(currentRemarksOrderId);
        });
    }

    // ===== REPAIR CATALOG =====
    function renderCatalog() {
        var container = document.getElementById('catalogContainer');
        var query = (document.getElementById('catalogSearchInput').value || '').toLowerCase().trim();
        var filtered = allRepairServices.filter(function(s) {
            if (currentCatalogFilter === 'ACTIVE' && !s.active) return false;
            if (currentCatalogFilter === 'INACTIVE' && s.active) return false;
            if (query) {
                var hay = ((s.name || '') + ' ' + (s.id || '') + ' ' + (s.category || '')).toLowerCase();
                if (hay.indexOf(query) === -1) return false;
            }
            return true;
        });
        if (filtered.length === 0) { container.innerHTML = '<div class="no-orders">No repairs match.</div>'; return; }

        var grouped = {};
        filtered.forEach(function(s) {
            var cat = s.category || 'General';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(s);
        });
        var order = (APP_CONFIG.repairCategories || []).slice();
        Object.keys(grouped).forEach(function(c) { if (order.indexOf(c) === -1) order.push(c); });
        container.innerHTML = '';
        order.forEach(function(cat) {
            if (!grouped[cat]) return;
            var group = document.createElement('div');
            group.className = 'catalog-group';
            var header = document.createElement('div');
            header.className = 'catalog-group-header';
            header.innerHTML = '<span>' + escapeHtml(cat) + ' &nbsp;·&nbsp; ' + grouped[cat].length + '</span><span class="chev">▼</span>';
            header.onclick = function() { group.classList.toggle('collapsed'); };
            group.appendChild(header);
            var body = document.createElement('div');
            body.className = 'catalog-group-body';
            grouped[cat].forEach(function(s) {
                var row = document.createElement('div');
                row.className = 'catalog-row' + (s.active ? '' : ' inactive');
                var priceHtml = '';
                if (s.pricing_model === 'quote') priceHtml = '<div class="catalog-row-price quote">Quote on inspection</div>';
                else if (s.pricing_model === 'flat') priceHtml = '<div class="catalog-row-price">RM' + (Number(s.price_flat) || 0) + '</div>';
                else if (s.pricing_model === 'per_model') {
                    var p = s.price_by_model || {};
                    priceHtml = '<div class="catalog-row-price-multi"><span><span class="m">OLED</span>RM' + (Number(p.OLED) || 0) + '</span><span><span class="m">V1/V2</span>RM' + (Number(p.V1_V2) || 0) + '</span><span><span class="m">LITE</span>RM' + (Number(p.LITE) || 0) + '</span></div>';
                }
                row.innerHTML = '<div class="catalog-row-main"><div class="catalog-row-name">' + escapeHtml(s.name) + '</div><div class="catalog-row-id">id: ' + escapeHtml(s.id) + ' &nbsp;·&nbsp; sort: ' + (s.sort_order || 0) + '</div>' + (s.note ? '<div class="catalog-row-note">' + escapeHtml(s.note) + '</div>' : '') + '</div>' + priceHtml + '<div class="catalog-row-actions"><button class="catalog-toggle-btn ' + (s.active ? 'on' : '') + '" onclick="toggleRepairActive(\'' + escapeHtml(s.id) + '\')">' + (s.active ? 'Active' : 'Inactive') + '</button><button class="catalog-edit-btn" onclick="openRepairForm(\'' + escapeHtml(s.id) + '\')">Edit</button><button class="catalog-delete-btn" onclick="deleteRepairService(\'' + escapeHtml(s.id) + '\')">Delete</button></div>';
                body.appendChild(row);
            });
            group.appendChild(body);
            container.appendChild(group);
        });
    }

    function populateCategorySelect() {
        var sel = document.getElementById('rfCategory');
        var current = sel.value;
        sel.innerHTML = '';
        (APP_CONFIG.repairCategories || []).forEach(function(c) {
            var o = document.createElement('option');
            o.value = c; o.textContent = c;
            sel.appendChild(o);
        });
        if (current) sel.value = current;
    }
    function suggestRepairId(name) {
        var idField = document.getElementById('rfId');
        if (!idField || idField.dataset.touched === '1') return;
        idField.value = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }
    function sanitizeRepairId() {
        var idField = document.getElementById('rfId');
        idField.dataset.touched = '1';
        idField.value = idField.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    }
    function onPricingModelChange() {
        var selected = document.querySelector('input[name="rfPricing"]:checked');
        var val = selected ? selected.value : '';
        document.querySelectorAll('.pricing-radio-row label').forEach(function(l) { l.classList.remove('checked'); });
        if (selected && selected.parentElement) selected.parentElement.classList.add('checked');
        document.getElementById('rfFlatPriceGroup').style.display = (val === 'flat') ? 'flex' : 'none';
        document.getElementById('rfPerModelGroup').style.display = (val === 'per_model') ? 'flex' : 'none';
    }

    function openRepairForm(id) {
        populateCategorySelect();
        var nameField = document.getElementById('rfName');
        var idField = document.getElementById('rfId');
        var catField = document.getElementById('rfCategory');
        var flatField = document.getElementById('rfPriceFlat');
        var oledField = document.getElementById('rfPriceOled');
        var v1v2Field = document.getElementById('rfPriceV1V2');
        var liteField = document.getElementById('rfPriceLite');
        var noteField = document.getElementById('rfNote');
        var sortField = document.getElementById('rfSortOrder');
        var activeField = document.getElementById('rfActive');
        var saveBtn = document.getElementById('rfSaveBtn');
        idField.dataset.touched = '0';

        if (id) {
            var svc = allRepairServices.find(function(s) { return s.id === id; });
            if (!svc) return;
            document.getElementById('repairFormTitle').textContent = 'Edit Repair Service';
            saveBtn.textContent = 'Save Changes';
            nameField.value = svc.name || '';
            idField.value = svc.id || '';
            idField.dataset.touched = '1';
            idField.readOnly = true;
            catField.value = svc.category || (APP_CONFIG.repairCategories[0] || 'General');
            noteField.value = svc.note || '';
            sortField.value = (svc.sort_order !== undefined && svc.sort_order !== null) ? svc.sort_order : 100;
            activeField.checked = !!svc.active;
            var pm = svc.pricing_model || 'flat';
            document.querySelectorAll('input[name="rfPricing"]').forEach(function(r) { r.checked = (r.value === pm); });
            if (pm === 'flat') flatField.value = svc.price_flat != null ? svc.price_flat : '';
            else if (pm === 'per_model') {
                var bm = svc.price_by_model || {};
                oledField.value = bm.OLED != null ? bm.OLED : '';
                v1v2Field.value = bm.V1_V2 != null ? bm.V1_V2 : '';
                liteField.value = bm.LITE != null ? bm.LITE : '';
            }
        } else {
            document.getElementById('repairFormTitle').textContent = 'Add Repair Service';
            saveBtn.textContent = 'Add Repair';
            nameField.value = ''; idField.value = ''; idField.readOnly = false;
            catField.value = APP_CONFIG.repairCategories[0] || 'General';
            flatField.value = ''; oledField.value = ''; v1v2Field.value = ''; liteField.value = '';
            noteField.value = ''; sortField.value = 100; activeField.checked = true;
            document.querySelectorAll('input[name="rfPricing"]').forEach(function(r) { r.checked = (r.value === 'flat'); });
        }
        onPricingModelChange();
        document.getElementById('repairFormOverlay').style.display = 'flex';
        document.getElementById('repairFormOverlay').dataset.editingId = id || '';
        lockBodyScroll();
    }

    function closeRepairForm() {
        document.getElementById('repairFormOverlay').style.display = 'none';
        document.getElementById('repairFormOverlay').dataset.editingId = '';
        unlockBodyScroll();
    }
    function closeRepairFormOnBackdrop(e) { if (e.target.id === 'repairFormOverlay') closeRepairForm(); }

    async function saveRepairForm() {
        var editingId = document.getElementById('repairFormOverlay').dataset.editingId || null;
        var name = (document.getElementById('rfName').value || '').trim();
        var id = (document.getElementById('rfId').value || '').trim().toLowerCase();
        var category = document.getElementById('rfCategory').value || 'General';
        var pricing = (document.querySelector('input[name="rfPricing"]:checked') || {}).value;
        var note = (document.getElementById('rfNote').value || '').trim() || null;
        var sortOrder = parseInt(document.getElementById('rfSortOrder').value, 10);
        if (isNaN(sortOrder)) sortOrder = 100;
        var active = !!document.getElementById('rfActive').checked;

        if (!name) return alert('Please enter a name.');
        if (!id) return alert('Please enter an ID.');
        if (!/^[a-z0-9_]+$/.test(id)) return alert('ID must be lowercase letters, numbers, underscores.');
        if (!pricing) return alert('Please choose a pricing model.');

        var priceFlat = null, priceByModel = null;
        if (pricing === 'flat') {
            var pf = parseFloat(document.getElementById('rfPriceFlat').value);
            if (isNaN(pf) || pf < 0) return alert('Enter a valid flat price.');
            priceFlat = pf;
        } else if (pricing === 'per_model') {
            var oled = parseFloat(document.getElementById('rfPriceOled').value);
            var v1v2 = parseFloat(document.getElementById('rfPriceV1V2').value);
            var lite = parseFloat(document.getElementById('rfPriceLite').value);
            if (isNaN(oled) || isNaN(v1v2) || isNaN(lite)) return alert('Enter prices for all 3 models.');
            priceByModel = { OLED: oled, V1_V2: v1v2, LITE: lite };
        }
        var payload = { name: name, category: category, pricing_model: pricing, price_flat: priceFlat, price_by_model: priceByModel, note: note, sort_order: sortOrder, active: active };

        var saveBtn = document.getElementById('rfSaveBtn');
        saveBtn.disabled = true;
        var orig = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        try {
            if (editingId) {
                var res = await supabaseClient.from('repair_services').update(payload).eq('id', editingId);
                if (res.error) throw res.error;
            } else {
                payload.id = id;
                if (allRepairServices.find(function(s) { return s.id === id; })) throw new Error('ID already exists.');
                var res2 = await supabaseClient.from('repair_services').insert([payload]);
                if (res2.error) throw res2.error;
            }
            await Promise.all([loadRepairServices(supabaseClient), loadRepairsAdmin()]);
            closeRepairForm(); renderCatalog();
            alert(editingId ? 'Updated.' : 'Added.');
        } catch (err) {
            alert('Failed: ' + (err.message || err));
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = orig;
        }
    }

    async function toggleRepairActive(id) {
        var svc = allRepairServices.find(function(s) { return s.id === id; });
        if (!svc) return;
        var res = await supabaseClient.from('repair_services').update({ active: !svc.active }).eq('id', id);
        if (res.error) return alert('Failed: ' + res.error.message);
        svc.active = !svc.active;
        await loadRepairServices(supabaseClient);
        renderCatalog();
    }

    function deleteRepairService(id) {
        var svc = allRepairServices.find(function(s) { return s.id === id; });
        if (!svc) return;
        var usedIn = 0;
        allOrders.forEach(function(o) {
            (Array.isArray(o.repairs) ? o.repairs : []).forEach(function(r) {
                if (typeof r === 'string' && r === id) usedIn++;
                else if (r && typeof r === 'object' && r.id === id) usedIn++;
            });
        });
        var msg = 'Delete "' + svc.name + '"?';
        if (usedIn > 0) {
            msg = '"' + svc.name + '" is in ' + usedIn + ' order(s).\n\nConsider marking Inactive instead.\n\nDelete anyway?';
        }
        inlineConfirm({
            title: 'Delete Repair',
            message: msg,
            confirmLabel: 'Delete',
            onConfirm: function() {
                supabaseClient.from('repair_services').delete().eq('id', id).then(function(res) {
                    if (res.error) { alert('Failed: ' + res.error.message); return; }
                    allRepairServices = allRepairServices.filter(function(s) { return s.id !== id; });
                    loadRepairServices(supabaseClient).then(renderCatalog);
                });
            }
        });
    }
    