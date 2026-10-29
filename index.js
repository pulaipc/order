    const supabaseClient = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);

    const BodyLock = (function() {
        let scrollY = 0;
        let lockCount = 0;
        function lock() {
            if (lockCount === 0) {
                scrollY = window.scrollY || window.pageYOffset || 0;
                document.body.style.top = '-' + scrollY + 'px';
                document.body.classList.add('modal-open');
            }
            lockCount++;
        }
        function unlock() {
            if (lockCount <= 0) return;
            lockCount--;
            if (lockCount === 0) {
                document.body.classList.remove('modal-open');
                document.body.style.top = '';
                window.scrollTo(0, scrollY);
            }
        }
        function attachBackdropGuard(overlayEl) {
            overlayEl.addEventListener('touchmove', function(e) {
                const modalContent = overlayEl.querySelector('.modal-content, .modal-card, .remarks-modal-card');
                if (modalContent && modalContent.contains(e.target)) return;
                e.preventDefault();
            }, { passive: false });
        }
        return { lock, unlock, attachBackdropGuard };
    })();

    const state = {
        selectedGames: new Map(),
        selectedRepairs: new Map(), // id -> { id, name, category, price, isQuote, note }
        repairSectionExpanded: false,
        maxSdSize: 0,
        usableStorageLimit: 0,
        isStorageConfigured: false,
        currentEditingOrderId: null,
        // The unguessable value that proves this browser may edit this order.
        // Never sent anywhere except as the p_token argument to save_order /
        // cancel_order. See supabase_order_tokens.sql.
        currentEditingToken: null,
        currentLoadedPhone: null,
        savedRemarksText: '',
        modalGamesExpanded: false,
        modalRemarksExpanded: false,
        statusMsgTimeout: null,
        gamesRerenderTimer: null,
        loadedOrderForSummary: null,
        // Shop-side adjustments applied by the admin (admin.html). Preserved
        // across customer re-saves so a granted discount is never lost.
        freeGamesCount: 0,
        discountRm: 0,
        // Popularity from real past orders (loaded via the game_order_counts
        // RPC). Counts maps title -> how many orders included it; hotGames is
        // the top slice that earns the fire badge in the selection list.
        gameOrderCounts: null,
        hotGames: new Set()
    };

    const $ = id => document.getElementById(id);
    const valOf = id => ($(id) ? $(id).value : '');

    function scrollToTop(e) {
        if (e) e.preventDefault();
        const summaryView = $('summaryView');
        if (summaryView && summaryView.classList.contains('active')) resetFormForNewOrder();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function scrollToPricing() {
        const el = $('pricingGuide');
        if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    // Pricing and Games are form-navigation buttons; their targets live inside
    // #formView. While the order summary is showing the form is hidden, so both
    // buttons would silently do nothing. Hide them for the duration of the
    // summary instead of leaving dead controls in the header.
    function setFormNavVisible(visible) {
        ['headerPricingBtn', 'headerGamesBtn'].forEach(id => {
            const btn = $(id);
            if (btn) btn.style.display = visible ? '' : 'none';
        });
    }

    function svgXIcon(size) {
        size = size || 22;
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>';
    }
    function svgCheckIcon(size) {
        size = size || 22;
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"></polyline></svg>';
    }

    // ===== REPAIR HELPERS (local, backed by config.js globals) =====
    function getSelectedRepairTotal() {
        let total = 0, quoteCount = 0;
        state.selectedRepairs.forEach(r => {
            if (r.isQuote) quoteCount++;
            else total += Number(r.price) || 0;
        });
        return { total: total, quoteCount: quoteCount, count: state.selectedRepairs.size };
    }

    function renderRepairSection() {
        const card = $('repairSectionCard');
        const serviceType = valOf('serviceTypeSelect');
        if (!serviceType) { card.classList.remove('show'); return; }
        card.classList.add('show');

        const model = valOf('consoleModelSelect');
        const isRepairOnly = serviceType === 'repair_only';
        const needsModel = (serviceType === 'jailbreak') || isRepairOnly;

        // Repair Only: rename section + auto-expand
        if (isRepairOnly) {
            $('repairSectionTitle').textContent = 'Repair Jobs (Required)';
            if (!state.repairSectionExpanded) {
                state.repairSectionExpanded = true;
                $('repairBody').classList.add('expanded');
                $('repairToggleLabel').textContent = 'Hide';
            }
        } else {
            $('repairSectionTitle').textContent = 'Repair Jobs (Optional)';
        }

        $('repairSectionSubtitle').textContent = isRepairOnly
            ? 'Pick the repairs you need. Diagnostic fee of RM30 is waived if a paid repair is selected.'
            : 'Select any repairs you\'d like done at the same time.';

        const warning = $('repairModelWarning');
        if (needsModel && !model) {
            warning.style.display = 'flex';
        } else {
            warning.style.display = 'none';
        }

        const container = $('repairCategoriesContainer');
        container.innerHTML = '';

        const services = window.REPAIR_SERVICES || [];
        const grouped = {};
        services.forEach(s => {
            const cat = s.category || 'General';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(s);
        });

        const orderedCategories = (APP_CONFIG.repairCategories || []).filter(c => grouped[c]);
        // Include any categories present in DB but not in the list (custom admin ones)
        Object.keys(grouped).forEach(c => { if (orderedCategories.indexOf(c) === -1) orderedCategories.push(c); });

        orderedCategories.forEach(cat => {
            const group = document.createElement('div');
            group.className = 'repair-category-group';
            const header = document.createElement('div');
            header.className = 'repair-category-header';
            header.textContent = cat;
            group.appendChild(header);

            grouped[cat].forEach(svc => {
                const selected = state.selectedRepairs.has(svc.id);
                const p = computeRepairPrice(svc, model || 'OLED');
                const item = document.createElement('div');
                item.className = 'repair-item' + (selected ? ' selected' : '');
                item.onclick = (e) => {
                    if (e.target.tagName !== 'INPUT') {
                        const cb = item.querySelector('input');
                        cb.checked = !cb.checked;
                        cb.onchange();
                    }
                };
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selected;
                cb.onchange = () => toggleRepair(svc);

                const info = document.createElement('div');
                info.className = 'repair-item-info';
                const nameEl = document.createElement('div');
                nameEl.className = 'repair-item-name';
                nameEl.textContent = svc.name;
                info.appendChild(nameEl);
                if (svc.note) {
                    const noteEl = document.createElement('div');
                    noteEl.className = 'repair-item-note';
                    noteEl.textContent = svc.note;
                    info.appendChild(noteEl);
                }

                const priceEl = document.createElement('div');
                priceEl.className = 'repair-item-price' + (p.isQuote ? ' quote' : '');
                priceEl.textContent = p.isQuote ? 'TBC' : p.label;

                item.appendChild(cb);
                item.appendChild(info);
                item.appendChild(priceEl);
                group.appendChild(item);
            });
            container.appendChild(group);
        });

        updateRepairSummaryBar();
    }

    function updateRepairSummaryBar() {
        const bar = $('repairSummaryBar');
        const count = state.selectedRepairs.size;
        if (count === 0) { bar.style.display = 'none'; $('repairSoftWarning').classList.remove('show'); return; }
        bar.style.display = 'flex';
        const { total, quoteCount } = getSelectedRepairTotal();
        $('repairCountLabel').textContent = count + ' repair' + (count === 1 ? '' : 's');
        $('repairQuoteLabel').textContent = quoteCount > 0 ? ' · ' + quoteCount + ' needing quote' : '';
        $('repairTotalLabel').textContent = 'RM' + total + (quoteCount > 0 ? ' + TBC' : '');

        // Soft warnings
        const warn = $('repairSoftWarning');
        const warnText = $('repairSoftWarningText');
        if (count >= 6) {
            warn.classList.add('show');
            warnText.innerHTML = '<strong>' + count + ' repairs selected.</strong> This is a major refurb. Make sure you\'ve discussed this with us on WhatsApp first — it may be more economical to consider a replacement unit.';
        } else if (count >= 4) {
            warn.classList.add('show');
            warnText.innerHTML = '<strong>' + count + ' repairs selected.</strong> That\'s a lot — make sure you know this is a major refurbishment. We\'ll confirm everything on WhatsApp.';
        } else {
            warn.classList.remove('show');
        }
    }

    function toggleRepair(svc) {
        if (state.selectedRepairs.has(svc.id)) {
            state.selectedRepairs.delete(svc.id);
        } else {
            const model = valOf('consoleModelSelect') || 'OLED';
            const p = computeRepairPrice(svc, model);
            state.selectedRepairs.set(svc.id, {
                id: svc.id,
                name: svc.name,
                category: svc.category || '',
                price: p.amount,
                isQuote: p.isQuote,
                note: svc.note || ''
            });
        }
        // Refresh checkboxes in case prices changed
        updateRepairSummaryBar();
        // Re-render just to update "selected" styling
        document.querySelectorAll('.repair-item').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.repair-item input:checked').forEach(cb => cb.closest('.repair-item').classList.add('selected'));
        updateStorageBreakdownAndCart();
    }

    function clearRepairs() {
        state.selectedRepairs.clear();
        document.querySelectorAll('.repair-item input').forEach(cb => { cb.checked = false; });
        document.querySelectorAll('.repair-item').forEach(el => el.classList.remove('selected'));
        updateRepairSummaryBar();
        updateStorageBreakdownAndCart();
    }

    function toggleRepairSection() {
        state.repairSectionExpanded = !state.repairSectionExpanded;
        const body = $('repairBody');
        const label = $('repairToggleLabel');
        if (state.repairSectionExpanded) { body.classList.add('expanded'); label.textContent = 'Hide'; }
        else { body.classList.remove('expanded'); label.textContent = 'Show'; }
    }

    // Refresh repair prices when model changes
    function refreshRepairPrices() {
        const model = valOf('consoleModelSelect') || 'OLED';
        const services = window.REPAIR_SERVICES || [];
        // Update stored prices
        state.selectedRepairs.forEach((r, id) => {
            const svc = services.find(s => s.id === id);
            if (!svc) return;
            const p = computeRepairPrice(svc, model);
            r.price = p.amount;
            r.isQuote = p.isQuote;
        });
        // Update UI prices
        document.querySelectorAll('.repair-item').forEach(item => {
            const nameEl = item.querySelector('.repair-item-name');
            if (!nameEl) return;
            const svc = services.find(s => s.name === nameEl.textContent);
            if (!svc) return;
            const p = computeRepairPrice(svc, model);
            const priceEl = item.querySelector('.repair-item-price');
            if (priceEl) {
                priceEl.className = 'repair-item-price' + (p.isQuote ? ' quote' : '');
                priceEl.textContent = p.isQuote ? 'TBC' : p.label;
            }
        });
        updateRepairSummaryBar();
    }

    // The private link lives inside the summary card, next to the order it belongs
    // to, instead of in a bar floating over the page. One place only, so it can
    // never end up describing a different order than the one on screen.
    function privateLinkBlockHtml() {
        const editUrl = buildShareUrl();
        if (!editUrl) return '';
        return '<div class="private-link-block">'
            + '<div class="private-link-head">&#128279; Your private link</div>'
            + '<div class="private-link-note">This link is the only thing that opens this order, so keep it somewhere you won\'t lose it.</div>'
            + '<div class="private-link-row">'
            + '  <input type="text" class="private-link-input" id="privateLinkInput" readonly value="' + escapeHtml(editUrl) + '">'
            + '  <button class="btn-action" onclick="copyPrivateLink(this)">Copy</button>'
            + '</div>'
            + '</div>';
    }

    function copyPrivateLink(btnEl) {
        const input = $('privateLinkInput');
        const value = input ? input.value : '';
        if (!value) return;
        navigator.clipboard.writeText(value).then(function () {
            const orig = btnEl.textContent;
            btnEl.textContent = 'Copied';
            setTimeout(function () { btnEl.textContent = orig; }, 1800);
        }).catch(function (err) { alert('Failed to copy: ' + err); });
    }

    function showSummaryView(order) {
        state.loadedOrderForSummary = order;
        // Adopt any shop-side adjustments so a later save preserves them.
        const shopAdj = getOrderTotals(order);
        state.freeGamesCount = shopAdj.freeGames;
        state.discountRm = shopAdj.discount;
        const summaryEl = $('summaryView');
        const formEl = $('formView');
        const checkoutBar = $('checkoutBar');

        formEl.classList.add('hidden');
        checkoutBar.classList.add('hidden');
        summaryEl.classList.add('active');
        document.body.classList.add('summary-active');
        setFormNavVisible(false);

        // Prefer the private tracker link. Falling back to the phone lookup is
        // only correct when there is no token yet, which cannot happen for a
        // loaded order.
        const trackLink = $('headerTrackLink');
        if (trackLink) {
            trackLink.href = buildTrackUrl(state.currentEditingToken)
                || (order.phone_ending ? 'track.html?phone=' + encodeURIComponent(order.phone_ending) : 'track.html');
        }

        const locked = isOrderLocked(order);
        const cancellable = isOrderCancellable(order);
        const stage = order.progress_stage || 'Order Received';
        const isCancelled = order.status === 'Cancelled';
        const isCompleted = !isCancelled && stage === 'Completed';

        let pillClass = '';
        if (isCancelled) pillClass = 'cancelled';
        else if (isCompleted) pillClass = 'done';
        else if (locked) pillClass = 'locked';

        const gameList = gameListOf(order);
        // Left in the order the customer picked them, which is the order they
        // will be copied in. The catalogue order would throw that away.
        const gameCount = gameCountTotal(gameList);
        let totalGb = 0;
        let unknownSizeCount = 0;
        const gamesWithSize = [];
        const sourceGames = typeof games !== 'undefined' ? games : [];
        gameList.forEach(name => {
            const found = sourceGames.find(g => g.name === name);
            // A name the catalogue does not hold (hand-typed, or since removed)
            // has no size to look up. Forcing it to 0 GB would quietly understate
            // the order, so it is counted separately and flagged in the list.
            if (!found) unknownSizeCount++;
            const size = found ? found.size : 0;
            totalGb += found ? effectiveGb(size) : 0;
            gamesWithSize.push({ name: name, size: size, known: !!found, fileCount: found ? found.fileCount : 1 });
        });

        const repairs = getEnrichedRepairs(order);
        const repairSum = sumRepairs(repairs);

        const serviceLabels = {
            'jailbreak': 'Full Jailbreak' + (order.console_model ? ' (' + order.console_model + ')' : ''),
            'system_setup': 'System Setup',
            'system_update': 'System Update',
            'games_only': 'Games Only',
            'repair_only': 'Repair Only'
        };
        const serviceLabel = serviceLabels[order.service_type] || 'Order';

        const created = order.created_at ? new Date(order.created_at).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'N/A';
        const updated = order.progress_updated_at || order.updated_at;
        const updatedStr = updated ? new Date(updated).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : created;

        let storageLabel;
        if (order.service_type === 'jailbreak' || order.service_type === 'system_setup') {
            // SD-card based services: show size + source
            const sizeStr = order.sd_card_size
                ? (order.sd_card_size >= 1000
                    ? (order.sd_card_size / 1024).toFixed(0) + ' TB'
                    : order.sd_card_size + ' GB')
                : 'N/A';
            const sourceStr = order.sd_source === 'buy'
                ? '<span style="color:#ffc000;">New card from us</span>'
                : (order.sd_source === 'own' ? 'Customer\'s own card' : '');
            storageLabel = sourceStr ? (sizeStr + ' · ' + sourceStr) : sizeStr;
        } else if (order.service_type === 'system_update' && order.free_storage_gb) {
            storageLabel = order.free_storage_gb + ' GB free space';
        } else if (order.free_storage_gb) {
            storageLabel = order.free_storage_gb + ' GB free';
        } else {
            storageLabel = 'N/A';
        }

        let html = '';
        html += '<div class="summary-card">';
        html += '<div class="summary-header">';
        html += '<div class="summary-header-left">';
        html += '<div class="summary-order-id">Order #' + (order.phone_ending || 'N/A') + '</div>';
        html += '<div class="summary-order-meta">Placed ' + created + '</div>';
        html += '</div>';
        html += '<span class="summary-stage-pill ' + pillClass + '">' + stage + '</span>';
        html += '</div>';

        html += '<div class="summary-grid">';
        html += '<div class="summary-section"><div class="summary-label">Service</div><div class="summary-value">' + serviceLabel + '</div></div>';
        if (order.service_type !== 'repair_only') {
            html += '<div class="summary-section"><div class="summary-label">Storage</div><div class="summary-value">' + storageLabel + '</div></div>';
        } else if (order.console_model) {
            html += '<div class="summary-section"><div class="summary-label">Console</div><div class="summary-value">' + order.console_model + '</div></div>';
        }
        html += '</div>';

        const addons = [];
        if (order.android_mode) addons.push('Android Mode (+RM30)');
        if (order.linux_mode) addons.push('Linux Mode (+RM30)');
        if (addons.length > 0) {
            html += '<div class="summary-section"><div class="summary-label">Add-ons</div><div class="summary-value">' + addons.join(' &nbsp;·&nbsp; ') + '</div></div>';
        }

        // Repairs section
        if (repairs.length > 0) {
            html += '<div class="summary-section">';
            html += '<div class="summary-label">Repair Jobs (' + repairs.length + ')</div>';
            repairs.forEach(r => {
                html += '<div class="summary-repair-item">';
                html += '<div class="summary-repair-name">' + escapeHtml(r.name) + (r.note ? '<span class="repair-note">' + escapeHtml(r.note) + '</span>' : '') + '</div>';
                html += '<div class="summary-repair-price' + (r.isQuote ? ' quote' : '') + '">' + (r.isQuote ? 'TBC' : 'RM' + r.price) + '</div>';
                html += '</div>';
            });
            html += '</div>';
        }

        // Games
        if (order.service_type !== 'repair_only') {
            html += '<div>';
            html += '<div class="summary-games-toggle" onclick="toggleSummaryGames(this)" aria-expanded="false">';
            html += '<span>' + gameCount + ' game' + (gameCount !== 1 ? 's' : '') + ' · ' + totalGb.toFixed(1) + ' GB' +
                (unknownSizeCount ? ' · ' + unknownSizeCount + ' unknown size' + (unknownSizeCount !== 1 ? 's' : '') : '') + '</span>';
            html += '<span class="chev">▼</span>';
            html += '</div>';
            html += '<div class="summary-games-list" id="summaryGamesList">';
            if (gamesWithSize.length === 0) {
                html += '<div style="text-align:center; color:#8a8272; padding:14px; font-size:13px;">No games selected yet.</div>';
            } else {
                gamesWithSize.forEach(g => {
                    var gCount = g.fileCount && g.fileCount > 1 ? g.fileCount + ' Games' : '';
                    var badgeHtml = gCount ? '<span class="game-count-badge">' + gCount + '</span>' : '';
                    html += '<div class="summary-game-item">';
                    html += '<div class="summary-game-name">' + escapeHtml(g.name) + badgeHtml + '</div>';
                    html += '<div class="summary-game-size' + (g.known ? '' : ' unknown') + '">' +
                             (g.known ? effectiveGb(g.size).toFixed(1) + ' GB' : 'size n/a') + '</div>';
                    html += '</div>';
                });
                if (unknownSizeCount) {
                    html += '<div class="summary-games-note">Size unknown for ' + unknownSizeCount +
                            ' game' + (unknownSizeCount !== 1 ? 's' : '') +
                            ' &mdash; the total counts only the games the shop has measured.</div>';
                }
            }
            html += '</div>';
            html += '</div>';
        }

        if (order.remarks && String(order.remarks).trim() !== '') {
            html += '<div class="summary-section">';
            html += '<div class="summary-label">Your remarks</div>';
            html += '<div class="summary-remarks">' + escapeHtml(order.remarks) + '</div>';
            html += '</div>';
        }

        const shopTotals = getOrderTotals(order);

        // save_order never writes a price - that is deliberate, so a customer
        // cannot change what they are charged. The side effect is that after the
        // customer edits their order the stored total describes the OLD
        // selection, not the one now on the order. So reprice what is actually
        // stored, through the same engine the cart and the dashboard use, and
        // show that as the total whenever the two disagree.
        //
        // Reprice with the SAME free-game waiver the shop granted. Comparing a
        // waived stored subtotal against an unwaived one would make every shop
        // waiver look like a customer edit, and the customer would be quoted the
        // full price on an order they had already been given free games on.
        const selPricing = computePricing(pricingInputsForOrder(order, shopTotals.freeGames));
        const selSubtotal = Math.max(0, Math.round(selPricing.subtotal));
        const repriced = selSubtotal !== shopTotals.subtotal;

        html += '<div class="summary-total' + (repriced ? ' repriced' : '') + '">';
        html += '<span class="summary-total-label">Total estimated' + (repairSum.quoteCount > 0 ? ' (+ ' + repairSum.quoteCount + ' quote)' : '') + '</span>';
        html += '<span class="summary-total-value">RM' + (repriced ? selSubtotal : shopTotals.total) + '</span>';
        html += '</div>';

        if (repriced) {
            html += '<div class="summary-price-note">'
                + 'This order was last priced at <strong>RM' + shopTotals.total + '</strong>, before your update. '
                + 'The total above is what your current selection comes to. '
                + 'We have your update and will confirm the final price with you before drop-off.'
                + '</div>';
        } else if (shopTotals.hasDiscount || shopTotals.freeGamesTotal > 0) {
            // Only meaningful while the subtotal still matches the selection: once
            // the selection has moved on, a discount granted against the old
            // subtotal would be a number that adds up to nothing.
            html += '<div class="summary-adjustments">';
            if (shopTotals.freeGamesTotal > 0) {
                // Bundled games count too: 3 in the package + 7 granted reads as
                // 10 free games, which is what the customer actually receives.
                const bundledNote = shopTotals.bundledFreeGames > 0
                    ? ' <span style="opacity:.7;">(' + shopTotals.bundledFreeGames + ' in package)</span>'
                    : '';
                html += '<div class="summary-adjustment-row"><span>Free games included' + bundledNote + '</span><span>' + shopTotals.freeGamesTotal + '</span></div>';
            }
            if (shopTotals.hasDiscount) {
                html += '<div class="summary-adjustment-row"><span>Subtotal</span><span>RM' + shopTotals.subtotal + '</span></div>';
                html += '<div class="summary-adjustment-row discount"><span>Discount</span><span>&minus;RM' + shopTotals.discount + '</span></div>';
            }
            html += '</div>';
        }

        if (updated) {
            html += '<div style="font-size:11.5px; color:#8a8272;">Last updated: ' + updatedStr + '</div>';
        }

        html += '</div>';

        html += '<div class="summary-card">';

        if (isCancelled) {
            const cancelPrefill = 'Hi, I cancelled order #' + (order.phone_ending || '') + ' and I\'d like to ask about it.';
            const waNumberC = getWhatsAppNumber();
            const waUrlC = 'https://wa.me/' + waNumberC + '?text=' + encodeURIComponent(cancelPrefill);
            html += '<div class="cancelled-banner" style="margin-top:0;"><span class="icon">' + svgXIcon(22) + '</span><div class="msg"><strong>Order Cancelled.</strong><br>This order has been cancelled. If you believe this is a mistake, message us on WhatsApp and we\'ll help.</div></div>';
            html += '<div class="summary-actions">';
            html += '<a class="summary-btn whatsapp" href="' + waUrlC + '" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>';
            html += '<button class="summary-btn secondary" onclick="resetFormForNewOrder()">&#10024; Start New Order</button>';
            html += '</div>';
        } else if (isCompleted) {
            const waNumberDone = getWhatsAppNumber();
            const prefillDone = 'Hi, I would like to ask about my completed order #' + (order.phone_ending || '') + '.';
            const waUrlDone = 'https://wa.me/' + waNumberDone + '?text=' + encodeURIComponent(prefillDone);
            html += '<div class="completed-banner" style="margin-top:0;"><span class="icon">' + svgCheckIcon(22) + '</span><div class="msg"><strong>Order complete.</strong><br>Thanks for your business. If you need anything else, message us or start a new order below.</div></div>';
            html += '<div class="summary-actions">';
            html += '<button class="summary-btn primary" onclick="resetFormForNewOrder()">&#10024; Start New Order</button>';
            html += '<a class="summary-btn secondary" href="' + waUrlDone + '" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>';
            html += '</div>';
        } else if (locked) {
            html += '<div class="locked-notice"><span class="locked-notice-icon">&#128274;</span><div><strong>This order is locked for changes.</strong><br>We\'ve already confirmed the details with you. If you need to make a change or cancel, message us on WhatsApp and we\'ll take care of it.</div></div>';
            html += privateLinkBlockHtml();
            html += '<div class="summary-actions">';
            const prefill = 'Hi, I would like to ask about my order #' + (order.phone_ending || '') + '.';
            const waNumber = getWhatsAppNumber();
            const waUrl = 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent(prefill);
            html += '<a class="summary-btn whatsapp" href="' + waUrl + '" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>';
            html += '<a class="summary-btn secondary" href="' + (buildTrackUrl(state.currentEditingToken) || 'track.html?phone=' + encodeURIComponent(order.phone_ending || '')) + '">Track Progress</a>';
            html += '<button class="summary-btn secondary" onclick="resetFormForNewOrder()">&#10024; Start New Order</button>';
            html += '</div>';
        } else {
            if (stage !== 'Order Received') {
                // Editing can only be happening because the shop opened the
                // window from the admin panel; say so, or the unlocked form
                // reads like a bug to the customer.
                html += '<div class="unlocked-notice"><span class="locked-notice-icon">&#9998;</span><div><strong>Editing is open on this order.</strong><br>We\'ve unlocked it for you &mdash; tap Edit Order to change games, services or repairs. It locks again once we\'ve received your changes.</div></div>';
            }
            html += privateLinkBlockHtml();
            html += '<div class="summary-actions">';
            html += '<button class="summary-btn primary" onclick="switchToEditForm()">Edit Order</button>';
            html += '<a class="summary-btn secondary" href="' + (buildTrackUrl(state.currentEditingToken) || 'track.html?phone=' + encodeURIComponent(order.phone_ending || '')) + '">Track Progress</a>';
            html += '<button class="summary-btn secondary" onclick="resetFormForNewOrder()">&#10024; Start New Order</button>';
            if (cancellable) html += '<button class="summary-btn cancel" onclick="cancelOrder()">Cancel Order</button>';
            html += '</div>';
        }
        html += '</div>';

        summaryEl.innerHTML = html;
    }

    function toggleSummaryGames(el) {
        const list = $('summaryGamesList');
        if (!list) return;
        const expanded = list.classList.toggle('expanded');
        el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function switchToEditForm() {
        const order = state.loadedOrderForSummary;
        if (!order) return;
        applyLoadedOrder(order);
        $('summaryView').classList.remove('active');
        $('formView').classList.remove('hidden');
        $('checkoutBar').classList.remove('hidden');
        document.body.classList.remove('summary-active');
        setFormNavVisible(true);
        setTimeout(() => {
            const configCard = $('configCard');
            if (configCard) configCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            else window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 50);
    }

    function hideSummaryShowForm() {
        $('summaryView').classList.remove('active');
        $('formView').classList.remove('hidden');
        $('checkoutBar').classList.remove('hidden');
        document.body.classList.remove('summary-active');
        setFormNavVisible(true);
        state.loadedOrderForSummary = null;
    }

    async function cancelOrder() {
        const order = state.loadedOrderForSummary;
        if (!order) return;
        if (!isOrderCancellable(order)) { alert('This order can no longer be cancelled here. Please message us on WhatsApp.'); return; }
        const confirmed = confirm('Cancel this order?\n\nThis can\'t be undone. You\'ll need to place a new order if you change your mind.');
        if (!confirmed) return;

        const btn = document.querySelector('.summary-btn.cancel');
        if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }

        try {
            const token = state.currentEditingToken || order.public_token;
            if (!token) throw new Error('This order was not opened from a private link, so it cannot be cancelled here.');

            // The cancellable check is repeated inside the function. This one is
            // only to save the customer a pointless round trip.
            const { data, error } = await supabaseClient.rpc('cancel_order', { p_token: token });
            if (error) throw error;
            if (!data || data.cancelled !== true) {
                alert('This order can no longer be cancelled here. Please message us on WhatsApp.');
                return;
            }

            const nowIso = new Date().toISOString();
            order.status = 'Cancelled';
            order.progress_stage = 'Cancelled';
            order.progress_updated_at = nowIso;
            order.updated_at = nowIso;
            showSummaryView(order);
        } catch (err) {
            console.error(err);
            alert('Failed to cancel: ' + (err.message || 'Please try again or message us on WhatsApp.'));
            if (btn) { btn.disabled = false; btn.textContent = 'Cancel Order'; }
        }
    }

    const SD_REAL_CAPACITY_FACTOR = 0.93;

    // Installed footprint of every selected game (raw sizes are stored raw).
    // INSTALL_SIZE_BUFFER and effectiveGb() live in shared.js so the admin order
    // editor plans on exactly the same figures as this form.
    function selectedGamesFootprint() {
        let total = 0;
        state.selectedGames.forEach(s => total += effectiveGb(s));
        return total;
    }

    function computeUsableStorage() {
        const serviceType = valOf('serviceTypeSelect');
        if (serviceType === 'games_only') {
            const userSpace = parseFloat(valOf('userFreeStorageInput'));
            if (isNaN(userSpace) || userSpace <= 0) return { usable: 0, baseOverhead: 0, partition: 0, realCapacity: 0 };
            return { usable: userSpace, baseOverhead: 0, partition: 0, realCapacity: userSpace };
        }

        const labelSize = state.maxSdSize;
        const realCapacity = Math.floor(labelSize * SD_REAL_CAPACITY_FACTOR);

        let baseOverhead = 0, partition = 0;
        if (labelSize <= 64) baseOverhead = 8;
        else if (labelSize <= 128) { baseOverhead = 10; partition = 10; }
        else if (labelSize <= 256) { baseOverhead = 16; partition = 16; }
        else if (labelSize <= 512) { baseOverhead = 20; partition = 20; }
        else { baseOverhead = 32; partition = 32; }

        let deduction = baseOverhead;
        if ($('androidModeCheck').checked) deduction += partition;
        if ($('linuxModeCheck').checked) deduction += partition;

        return { usable: Math.max(0, realCapacity - deduction), baseOverhead: baseOverhead, partition: partition, realCapacity: realCapacity };
    }

    function buildStorageBreakdownText() {
        const serviceType = valOf('serviceTypeSelect');
        const consoleModel = valOf('consoleModelSelect');
        const sdSource = valOf('sdSourceSelect');

        const gSize = selectedGamesFootprint();

        // ===== SYSTEM UPDATE: no SD config, just free space + games =====
        if (serviceType === 'system_update') {
            const userSpace = parseFloat(valOf('userFreeStorageInput')) || 0;
            state.usableStorageLimit = userSpace;
            if (userSpace <= 0) {
                return 'Service: System Update | <span style="color:#8a8272;">Enter free GB above to add games, or leave blank for update only.</span>';
            }
            return `Service: System Update | Stated Free Storage: ${userSpace} GB<br><strong>Selected Games: ${gSize.toFixed(1)} GB${installBufferNote()}</strong> / Available Balance: <strong>${(userSpace - gSize).toFixed(1)} GB</strong>`;
        }

        // ===== GAMES ONLY =====
        if (serviceType === 'games_only') {
            const userSpace = parseFloat(valOf('userFreeStorageInput'));
            state.usableStorageLimit = (isNaN(userSpace) || userSpace <= 0) ? 0 : userSpace;
            return `Service: Games Only | Stated Free Storage: ${state.usableStorageLimit} GB<br><strong>Selected Games: ${gSize.toFixed(1)} GB${installBufferNote()}</strong> / Available Balance: <strong>${(state.usableStorageLimit - gSize).toFixed(1)} GB</strong>`;
        }

        // ===== JAILBREAK / SYSTEM SETUP (SD-card based) =====
        const { usable, baseOverhead, partition, realCapacity } = computeUsableStorage();
        state.usableStorageLimit = usable;

        const sdLabel = state.maxSdSize >= 1000 ? `${(state.maxSdSize / 1024).toFixed(0)}TB` : `${state.maxSdSize}GB`;
        const sourceLabel = sdSource === 'buy' ? 'New SD Card' : 'Own SD Card';
        const serviceLabel = serviceType === 'jailbreak' ? `Full Jailbreak (${consoleModel})` : 'System Setup';
        let text = `Service: ${serviceLabel} | SD: ${sdLabel} (${sourceLabel}) | Real capacity: ~${realCapacity}GB | System OS: -${baseOverhead}GB`;
        if ($('androidModeCheck').checked) text += ` | Android: -${partition}GB`;
        if ($('linuxModeCheck').checked) text += ` | Linux: -${partition}GB`;
        text += `<br><strong>Selected Games: ${gSize.toFixed(1)} GB${installBufferNote()}</strong> / Usable Limit: <strong>${usable} GB</strong>`;
        return text;
    }

    function updateStorageBreakdownAndCart() {
        if (!state.isStorageConfigured) { updateCartSummary(); return; }
        $('storageBreakdown').innerHTML = '<span>' + buildStorageBreakdownText() + '</span>';
        updateCartSummary();
    }

    function setStatusMessage(text, color = '#e8dcc0', autoDismissMs = 6000) {
        const el = $('statusMsg');
        if (!el) return;
        if (state.statusMsgTimeout) { clearTimeout(state.statusMsgTimeout); state.statusMsgTimeout = null; }
        el.classList.remove('fading');
        el.style.color = color;
        el.innerText = text;
        if (autoDismissMs > 0) {
            state.statusMsgTimeout = setTimeout(() => {
                el.classList.add('fading');
                setTimeout(() => { if (el.classList.contains('fading')) { el.innerText = ''; el.classList.remove('fading'); } }, 400);
            }, autoDismissMs);
        }
    }
    function clearStatusMessage() {
        const el = $('statusMsg');
        if (!el) return;
        if (state.statusMsgTimeout) { clearTimeout(state.statusMsgTimeout); state.statusMsgTimeout = null; }
        el.classList.remove('fading');
        el.innerText = '';
    }

    window.onload = async function() {
        ['cartModal'].forEach(id => {
            const el = $(id);
            if (el) BodyLock.attachBackdropGuard(el);
        });

        // Footer contact link: label only, never the number. The href carries
        // it so WhatsApp opens the chat, but nothing on the page displays it.
        const footerWa = $('footerWaLink');
        if (footerWa) footerWa.href = 'https://wa.me/' + getWhatsAppNumber();

        // Load service pricing and repair catalog first
        await Promise.all([
            loadServicePricing(supabaseClient),
            loadRepairServices(supabaseClient)
        ]);

        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get('t');
        const legacyOrderId = params.get('order');
        const urlPhone = params.get('phone');

        if (urlToken) {
            setTimeout(() => loadOrderByToken(urlToken), 400);
        } else if (legacyOrderId) {
            // Links sent before the private-token change used ?order=<id>, where
            // id is a sequential integer. That is exactly why the token exists,
            // so these links stop working at cutover. Point the customer at the
            // shop rather than showing an error they cannot act on.
            setTimeout(showLegacyLinkNotice, 400);
        } else if (urlPhone && /^\d{4}$/.test(urlPhone)) {
            $('phoneInput').value = urlPhone;
            try { localStorage.removeItem('userPhone4'); } catch (e) {}
        } else {
            $('phoneInput').value = '';
            try { localStorage.removeItem('userPhone4'); } catch (e) {}
        }

        toggleServiceFields();
        updateSdLimit();
        filterGames();
        // Popular titles (from real orders) load async and re-render with the
        // fire badge when they arrive.
        loadHotGames();
        updateSaveButtonLabel();
        renderRepairSection();
    };

    async function loadOrderByToken(token) {
        setStatusMessage('Loading your order...', '#7dd3fc', 0);
        try {
            const { data, error } = await supabaseClient.rpc('order_by_token', { p_token: token });
            if (error) throw error;

            if (!data) {
                hideSummaryShowForm();
                clearStatusMessage();
                showMissingOrderNotice();
                return;
            }
            const order = data;
            state.currentEditingOrderId = order.id;
            state.currentEditingToken = order.public_token || token;
            state.currentLoadedPhone = order.phone_ending || null;
            $('phoneInput').value = order.phone_ending || '';
            showSummaryView(order);
            updateSaveButtonLabel();
            clearStatusMessage();
            // The header Track link is the only other place that needs the token.
setStatusMessage('Order loaded successfully. Review and proceed to payment/modification.', '#25D366', 5000);
            const trackLinkNow = $('headerTrackLink');
            if (trackLinkNow) trackLinkNow.href = buildTrackUrl(state.currentEditingToken) || 'track.html';
            // The private link is rendered inside the summary card by
            // showSummaryView, so there is nothing extra to show here.

            // ?edit=1 comes from the Tracker's "Edit Order" button: it lands the
            // customer straight in the form instead of making them press Edit
            // Order on the summary first. Guarded by the same lock the button
            // itself is hidden behind, so a stale link can never drop someone into
            // the form of an order that has moved on. Read the param here rather
            // than reusing the init function's, which is out of scope.
            const deepLinkEdit = new URLSearchParams(window.location.search).get('edit') === '1';
            if (deepLinkEdit && !isOrderLocked(order)) {
                switchToEditForm();
            }
        } catch (err) {
            console.error(err);
            hideSummaryShowForm();
            clearStatusMessage();
            showMissingOrderNotice();
        }
    }

    // ?order=<id> links predate the private tokens. See the URL handling above.
    function showLegacyLinkNotice() {
        dismissFoundOrdersNotice();
        const waNumber = getWhatsAppNumber();
        const text = encodeURIComponent("Hi, my old order link doesn't work any more. Could you send me a new tracking link?");
        const notice = document.createElement('div');
        notice.className = 'missing-order-notice found-orders-panel';
        notice.innerHTML = ''
            + '<button class="missing-order-close" onclick="dismissFoundOrdersNotice()" aria-label="Close">&#10005;</button>'
            + '<div class="missing-order-title">This link is no longer valid</div>'
            + '<div class="missing-order-body">'
            + 'For everyone\'s privacy, order links now use a private code instead of a sequential order number. '
            + 'If this link came from us it may have been mistyped, or the order may have been removed. '
            + 'Message us and we\'ll send you a fresh link.'
            + '</div>'
            + '<div class="missing-order-actions">'
            + (waNumber
                ? '  <a class="missing-order-btn whatsapp" href="https://wa.me/' + waNumber + '?text=' + text + '" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>'
                : '')
            + '  <button class="missing-order-btn secondary" onclick="dismissFoundOrdersNotice()">&#10024; Start a new order</button>'
            + '</div>';
        attachNoticeBackdrop(notice);
        const bar = $('checkoutBar');
        if (bar) bar.classList.add('hidden');
    }

    function showMissingOrderNotice() {
        dismissFoundOrdersNotice();
        const notice = document.createElement('div');
        notice.className = 'missing-order-notice';
        const waNumber = getWhatsAppNumber();
        const waText = encodeURIComponent('Hi, I clicked my order link and it says the order is no longer valid. Can you check for me?');
        notice.innerHTML = ''
            + '<button class="missing-order-close" onclick="dismissMissingOrderNotice()" aria-label="Close">&#10005;</button>'
            + '<div class="missing-order-title">This order link is no longer valid</div>'
            + '<div class="missing-order-body">The order this link points to has been removed or does not exist. If you recently placed an order and need help, please message us on WhatsApp.</div>'
            + '<div class="missing-order-actions">'
            + '  <a class="missing-order-btn whatsapp" href="https://wa.me/' + waNumber + '?text=' + waText + '" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a>'
            + '  <button class="missing-order-btn secondary" onclick="dismissMissingOrderNotice()">&#10024; Start a new order</button>'
            + '</div>';
        attachNoticeBackdrop(notice);
        const bar = $('checkoutBar');
        if (bar) bar.classList.add('hidden');
    }

    function dismissMissingOrderNotice() {
        const notice = document.querySelector('.missing-order-notice');
        const backdrop = document.querySelector('.notice-backdrop');
        if (notice) notice.remove();
        if (backdrop) { backdrop.remove(); BodyLock.unlock(); }
        resetFormForNewOrder();
        const bar = $('checkoutBar');
        if (bar) bar.classList.remove('hidden');
    }

    function populateSdCardOptions() {
        const sdSelect = $('sdCardSelect');
        if (!sdSelect) return;
        const sdSource = valOf('sdSourceSelect');
        const currentValue = sdSelect.value;

        sdSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.textContent = '— Please select card —';
        if (!currentValue) placeholder.selected = true;
        sdSelect.appendChild(placeholder);

        if (sdSource === 'own') {
            const ownSizes = [
                { v: '64', l: '64 GB Card' }, { v: '128', l: '128 GB Card' }, { v: '256', l: '256 GB Card' },
                { v: '512', l: '512 GB Card' }, { v: '1024', l: '1 TB Card' }, { v: '2048', l: '2 TB Card' }
            ];
            ownSizes.forEach(({ v, l }) => {
                const o = document.createElement('option');
                o.value = v; o.textContent = l;
                if (currentValue === v) o.selected = true;
                sdSelect.appendChild(o);
            });
        } else if (sdSource === 'buy' && APP_CONFIG.sdCardRetailPrices) {
            let hasOptions = false;
            Object.entries(APP_CONFIG.sdCardRetailPrices).forEach(([size, price]) => {
                const p = Number(price);
                if (p > 0) {
                    hasOptions = true;
                    const o = document.createElement('option');
                    o.value = size;
                    const label = size >= 1000 ? `${(size / 1024).toFixed(0)} TB` : `${size} GB`;
                    o.textContent = `${label} Card (RM${p})`;
                    if (currentValue === size) o.selected = true;
                    sdSelect.appendChild(o);
                }
            });
            if (!hasOptions) {
                const o = document.createElement('option');
                o.value = '256'; o.textContent = '256 GB Card';
                sdSelect.appendChild(o);
            }
        }
    }

    function validatePhoneProvided() {
        const input = $('phoneInput');
        const phone = input.value.trim();
        if (!phone || phone.length < 4) {
            alert('Please enter the last 4 digits of your phone number first at the top before choosing games.');
            input.classList.add('required-missing');
            input.focus();
            return false;
        }
        input.classList.remove('required-missing');
        return true;
    }

    function savePhone() {
        const input = $('phoneInput');
        const phone = input.value.trim();
        if (phone.length >= 4) input.classList.remove('required-missing');

        if (state.currentEditingOrderId && phone.length < 4) hideEditModeBanner();
        else if (state.currentEditingOrderId && phone.length === 4 && state.currentLoadedPhone === phone) showEditModeBanner();

        if (state.currentEditingOrderId && state.currentLoadedPhone && phone !== state.currentLoadedPhone && phone.length === 4) {
            autoExitEditModeForNewPhone(phone);
        }
    }

    function toggleStorageGuide() {
        const box = $('storageGuideBox');
        box.style.display = (box.style.display === 'block') ? 'none' : 'block';
    }

    function toggleServiceFields() {
        const serviceType = valOf('serviceTypeSelect');
        const isRepairOnly = serviceType === 'repair_only';

        if (!serviceType) {
            ['consoleModelGroup', 'sdSourceGroup', 'sdCardGroup', 'freeStorageContainer', 'jailbreakModesContainer', 'jailbreakNoticeCard', 'gameSectionWrapper'].forEach(id => $(id).style.display = 'none');
            $('repairSectionCard').classList.remove('show');
            updateSdLimit();
            return;
        }

        // Repair Only: no SD, no games — just repairs
        if (isRepairOnly) {
            $('consoleModelGroup').style.display = 'flex'; // model affects per_model repair prices
            $('sdSourceGroup').style.display = 'none';
            $('sdCardGroup').style.display = 'none';
            $('freeStorageContainer').style.display = 'none';
            $('jailbreakModesContainer').style.display = 'none';
            $('androidModeCheck').checked = false;
            $('linuxModeCheck').checked = false;
            $('jailbreakNoticeCard').style.display = 'none';
            $('gameSectionWrapper').style.display = 'none';
            state.isStorageConfigured = true;
            state.usableStorageLimit = 0;
            $('storageWarningBanner').style.display = 'none';
            $('storageBreakdown').innerHTML = '<span>Service: Repair Only | Select repairs below.</span>';
            $('mainSubmitBtn').disabled = false;
            renderRepairSection();
            updateCartSummary();
            return;
        }

        // System Update: no model, no SD config, no addons. Just free space + games.
        if (serviceType === 'system_update') {
            $('consoleModelGroup').style.display = 'none';
            $('sdSourceGroup').style.display = 'none';
            $('sdCardGroup').style.display = 'none';
            $('freeStorageContainer').style.display = 'flex';
            var fsh = $('freeStorageHint');
            if (fsh) fsh.textContent = 'Only required if you\'re adding games. Leave blank for update only.';
            $('jailbreakModesContainer').style.display = 'none';
            $('androidModeCheck').checked = false;
            $('linuxModeCheck').checked = false;
            $('jailbreakNoticeCard').style.display = 'none';
            $('gameSectionWrapper').style.display = 'block';

            var suHint = $('consoleModelHint');
            if (suHint) suHint.textContent = 'Select your Nintendo Switch model variant';

            renderRepairSection();
            updateSdLimit();
            return;
        }

        const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');

        if (isJbOrSetup) {
            $('consoleModelGroup').style.display = (serviceType === 'jailbreak') ? 'flex' : 'none';
            $('sdSourceGroup').style.display = 'flex';
            $('sdCardGroup').style.display = 'flex';
            $('freeStorageContainer').style.display = 'none';
            var fsh = $('freeStorageHint');
            if (fsh) fsh.textContent = 'Remaining GB available on your Switch SD card';
            $('jailbreakModesContainer').style.display = 'flex';

            const label = (serviceType === 'jailbreak') ? 'Full Jailbreak' : 'System Setup';
            const notice = $('jailbreakNoticeCard');
            notice.querySelector('h3').innerText = `Your ${label} package includes 3 games at no extra cost`;
            notice.querySelector('p').innerText = `Your ${label} package includes your first 3 games at no additional charge. Select them below, then add more if you'd like.`;

            if (state.selectedGames.size === 0) {
                notice.style.display = 'block';
                $('gameSectionWrapper').style.display = 'none';
            } else {
                notice.style.display = 'none';
                $('gameSectionWrapper').style.display = 'block';
            }
        } else {
            $('consoleModelGroup').style.display = 'none';
            $('sdSourceGroup').style.display = 'none';
            $('sdCardGroup').style.display = 'none';
            $('freeStorageContainer').style.display = 'flex';
            $('jailbreakModesContainer').style.display = 'none';
            $('androidModeCheck').checked = false;
            $('linuxModeCheck').checked = false;
            $('jailbreakNoticeCard').style.display = 'none';
            $('gameSectionWrapper').style.display = 'block';
        }
        // Update the console-model hint based on service type
        var modelHint = $('consoleModelHint');
        if (modelHint) {
            if (isRepairOnly) {
                modelHint.textContent = 'Select your Switch model — repair prices vary by model';
            } else if (serviceType === 'jailbreak') {
                modelHint.textContent = 'Select your Switch model variant (affects jailbreak + repair pricing)';
            } else if (serviceType === 'system_setup') {
                modelHint.textContent = 'Select your Nintendo Switch model variant';
            } else {
                modelHint.textContent = 'Select your Nintendo Switch model variant';
            }
        }

        renderRepairSection();
        updateSdLimit();
    }

    function revealGameSection() {
        if (!validatePhoneProvided()) return;
        if (!state.isStorageConfigured) {
            alert('Please enter your available Free Storage Space (GB) first!');
            $('userFreeStorageInput').focus();
            return;
        }
        $('jailbreakNoticeCard').style.display = 'none';
        $('gameSectionWrapper').style.display = 'block';
        filterGames();
    }

    function updateSdLimit() {
        const serviceType = valOf('serviceTypeSelect');
        const consoleModel = valOf('consoleModelSelect');
        const sdSource = valOf('sdSourceSelect');

        // System Update: free space optional. Needed only to pick games.
        if (serviceType === 'system_update') {
            const freeInput = $('userFreeStorageInput');
            let userSpace = parseFloat(freeInput.value);
            if (!isNaN(userSpace) && userSpace > 2048) { userSpace = 2048; freeInput.value = 2048; }

            const hasFreeSpace = !isNaN(userSpace) && userSpace > 0;

            state.usableStorageLimit = hasFreeSpace ? userSpace : 0;
            state.isStorageConfigured = hasFreeSpace;

            if (hasFreeSpace) {
                // Free space given → unlock game list
                freeInput.classList.remove('required-missing');
                $('storageWarningBanner').style.display = 'none';
                $('gameSectionWrapper').classList.remove('locked');

                const gSize = selectedGamesFootprint();
                $('storageBreakdown').innerHTML = '<span>Service: System Update | Stated Free Storage: ' + userSpace + ' GB<br><strong>Selected Games: ' + gSize.toFixed(1) + ' GB' + installBufferNote() + '</strong> / Available Balance: <strong>' + (userSpace - gSize).toFixed(1) + ' GB</strong></span>';
            } else {
                // No free space → freeze game list, clear any games, update-only state
                freeInput.classList.remove('required-missing');
                $('storageWarningBanner').style.display = 'none';
                $('gameSectionWrapper').classList.add('locked');

                // (B): wipe game selection so the order is cleanly update-only
                if (state.selectedGames.size > 0) {
                    state.selectedGames.clear();
                }

                $('storageBreakdown').innerHTML = '<span>Service: System Update | <span style="color:#8a8272;">Enter free GB above to add games, or leave blank for update only.</span></span>';
            }

            // Trim excess games when free space shrinks below selected total
            if (hasFreeSpace && state.usableStorageLimit > 0) {
                const gSize = selectedGamesFootprint();
                if (gSize > state.usableStorageLimit) {
                    alert(`Your storage limit (${state.usableStorageLimit} GB) is smaller than your selected games (${gSize.toFixed(1)} GB after install). Excess games will be automatically removed.`);
                    let acc = 0;
                    const toRemove = [];
                    state.selectedGames.forEach((sz, name) => { acc += effectiveGb(sz); if (acc > state.usableStorageLimit) toRemove.push(name); });
                    toRemove.forEach(n => state.selectedGames.delete(n));
                }
            }

            // Submit allowed regardless (order can be update-only)
            $('mainSubmitBtn').disabled = false;

            if ($('gameSectionWrapper').style.display !== 'none') scheduleGamesRerender();
            refreshRepairPrices();
            updateCartSummary();
            return;
        }
        const warning = $('storageWarningBanner');
        const warningText = $('storageWarningText');
        const freeInput = $('userFreeStorageInput');
        const gameWrapper = $('gameSectionWrapper');
        const submitBtn = $('mainSubmitBtn');
        const breakdown = $('storageBreakdown');
        const browseBtn = $('browseGamesBtn');

        // Repair Only path
        if (serviceType === 'repair_only') {
            state.isStorageConfigured = true;
            state.usableStorageLimit = 0;
            warning.style.display = 'none';
            submitBtn.disabled = false;
            // Update repair prices in case model changed
            refreshRepairPrices();
            updateCartSummary();
            return;
        }

        const setWaiting = (msg) => {
            state.isStorageConfigured = false;
            state.usableStorageLimit = 0;
            warning.style.display = 'flex';
            warningText.innerHTML = msg;
            gameWrapper.classList.add('locked');
            submitBtn.disabled = true;
            // The banner above already says exactly what is missing. This used to
            // repeat the same sentence in the checkout bar, so it appeared twice
            // on one screen; the bar keeps its own job and just reports that
            // storage is not configured yet.
            breakdown.innerHTML = '<span>Storage: <span style="color:#8a8272;">not set yet</span></span>';
            updateCartSummary();
        };

        if (!serviceType) return setWaiting('Please select a <strong>Service Type</strong> above to begin.');
        if (serviceType === 'jailbreak' && !consoleModel) return setWaiting('Please select your <strong>Console Model</strong> to continue.');

        const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');
        if (isJbOrSetup && !sdSource) return setWaiting('Please select your <strong>SD Card Source</strong> to continue.');

        populateSdCardOptions();
        const sdValue = valOf('sdCardSelect');
        state.maxSdSize = parseInt(sdValue) || 0;

        if (isJbOrSetup && !sdValue) return setWaiting('Please select your <strong>SD Card Capacity</strong> to continue.');

        if (isJbOrSetup) {
            const android = $('androidModeCheck');
            const linux = $('linuxModeCheck');
            const modesLockedNotice = $('modesLockedNotice');
            const androidWrapper = android.closest('.mode-wrapper');
            const linuxWrapper = linux.closest('.mode-wrapper');

            if (state.maxSdSize < 128) {
                if (android.checked) android.checked = false;
                if (linux.checked) linux.checked = false;
                android.disabled = true;
                linux.disabled = true;
                if (androidWrapper) androidWrapper.classList.add('mode-disabled');
                if (linuxWrapper) linuxWrapper.classList.add('mode-disabled');
                if (modesLockedNotice) modesLockedNotice.style.display = 'flex';
            } else {
                android.disabled = false;
                linux.disabled = false;
                if (androidWrapper) androidWrapper.classList.remove('mode-disabled');
                if (linuxWrapper) linuxWrapper.classList.remove('mode-disabled');
                if (modesLockedNotice) modesLockedNotice.style.display = 'none';
            }

            state.usableStorageLimit = computeUsableStorage().usable;
            state.isStorageConfigured = true;

            freeInput.classList.remove('required-missing');
            warning.style.display = 'none';
            gameWrapper.classList.remove('locked');
            if (browseBtn) browseBtn.disabled = false;
            submitBtn.disabled = false;
            breakdown.innerHTML = '<span>' + buildStorageBreakdownText() + '</span>';
        } else {
            let userSpace = parseFloat(freeInput.value);
            if (!isNaN(userSpace) && userSpace > 2048) { userSpace = 2048; freeInput.value = 2048; }

            if (isNaN(userSpace) || userSpace <= 0) {
                state.isStorageConfigured = false;
                state.usableStorageLimit = 0;
                freeInput.classList.add('required-missing');
                warning.style.display = 'flex';
                warningText.innerHTML = 'Please enter your available <strong>Free Storage Space (GB)</strong> above to unlock game selection.';
                gameWrapper.classList.add('locked');
                submitBtn.disabled = true;
                breakdown.innerHTML = '<span>Service: Games Only | <span style="color:#e57373;">Storage space missing. Enter free GB to continue.</span></span>';
            } else {
                state.usableStorageLimit = userSpace;
                state.isStorageConfigured = true;
                freeInput.classList.remove('required-missing');
                warning.style.display = 'none';
                gameWrapper.classList.remove('locked');
                submitBtn.disabled = false;
                breakdown.innerHTML = '<span>' + buildStorageBreakdownText() + '</span>';
            }
        }

        const gSize = selectedGamesFootprint();
        if (state.isStorageConfigured && state.usableStorageLimit > 0 && gSize > state.usableStorageLimit) {
            alert(`Your new storage limit (${state.usableStorageLimit} GB) is smaller than your selected games (${gSize.toFixed(1)} GB after install). Excess games will be automatically removed.`);
            let acc = 0;
            const toRemove = [];
            state.selectedGames.forEach((sz, name) => { acc += effectiveGb(sz); if (acc > state.usableStorageLimit) toRemove.push(name); });
            toRemove.forEach(n => state.selectedGames.delete(n));
        }

        if (gameWrapper.style.display !== 'none') scheduleGamesRerender();
        // Refresh repair prices too (model may have changed)
        refreshRepairPrices();
        updateCartSummary();
    }

    function resetFormForNewOrder() {
        state.currentEditingOrderId = null;
        state.currentEditingToken = null;
        state.currentLoadedPhone = null;
        state.selectedGames.clear();
        state.selectedRepairs.clear();
        state.savedRemarksText = '';
        state.loadedOrderForSummary = null;
        state.freeGamesCount = 0;
        state.discountRm = 0;
        ['androidModeCheck', 'linuxModeCheck'].forEach(id => $(id).checked = false);
        ['serviceTypeSelect', 'consoleModelSelect', 'sdSourceSelect', 'userFreeStorageInput', 'searchInput'].forEach(id => $(id).value = '');
        window.history.replaceState({}, '', window.location.pathname);
        populateSdCardOptions();
        toggleServiceFields();
        updateSdLimit();
        filterGames();
        hideEditModeBanner();
        const trackLink = $('headerTrackLink');
        if (trackLink) trackLink.href = 'track.html';
        hideSummaryShowForm();
        updateSaveButtonLabel();
        renderRepairSection();
    }

    function clearAllSelections() {
        if (state.selectedGames.size === 0 && state.selectedRepairs.size === 0 && !$('androidModeCheck').checked && !$('linuxModeCheck').checked) return;
        if (confirm('Are you sure you want to clear all selected games, repairs, and modes?')) {
            resetFormForNewOrder();
            setStatusMessage('Selections cleared.', '#e57373', 4000);
        }
    }

    function showEditModeBanner() { const b = $('editModeBanner'); if (b) b.style.display = 'flex'; }
    function hideEditModeBanner() { const b = $('editModeBanner'); if (b) b.style.display = 'none'; }

    function autoExitEditModeForNewPhone(newPhone) {
        resetFormForNewOrder();
        setStatusMessage(`Cleared previous order. Now starting a new order for phone "${newPhone}".`, '#00e676', 6000);
    }

    function scheduleGamesRerender() {
        if (state.gamesRerenderTimer) clearTimeout(state.gamesRerenderTimer);
        state.gamesRerenderTimer = setTimeout(() => { state.gamesRerenderTimer = null; filterGames(); }, 120);
    }

    // ===== HOT GAMES (badged from real past orders) =====
    // The top HOT_GAME_TOP most-ordered titles (with at least HOT_GAME_MIN
    // orders) earn a fire badge in the selection list. Kept as constants so
    // the shop can tune what counts as "hot" without touching the SQL.
    const HOT_GAME_TOP = 10;
    const HOT_GAME_MIN = 2;

    function hotBadgeHtml(name) {
        if (!state.hotGames || !state.hotGames.has(name)) return '';
        const n = (state.gameOrderCounts && state.gameOrderCounts[name]) || 0;
        return '<span class="hot-badge" title="Popular — ordered in ' + n +
            ' order' + (n !== 1 ? 's' : '') + '">&#128293;</span>';
    }

    // Fills state.hotGames from the DB, then re-renders the list so the
    // badges appear. Silent on failure: a missing RPC or offline DB simply
    // means no badges, never a broken page.
    async function loadHotGames() {
        try {
            const { data, error } = await supabaseClient.rpc('game_order_counts');
            if (error || !Array.isArray(data) || data.length === 0) return;
            const counts = {};
            data.forEach(row => { counts[row.game_name] = Number(row.order_count) || 0; });
            state.gameOrderCounts = counts;
            state.hotGames = new Set(
                Object.keys(counts)
                    .filter(name => counts[name] >= HOT_GAME_MIN)
                    .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
                    .slice(0, HOT_GAME_TOP)
            );
            filterGames();
        } catch (e) { /* cosmetic only */ }
    }

    // ===== GAME LIST VIEW MODE (cover grid vs compact list) =====
    // Remembered per browser so customers get their preferred layout back.
    function gameViewMode() {
        var m = null;
        try { m = localStorage.getItem('pulai.gameView'); } catch (e) {}
        return (m === 'list') ? 'list' : 'grid';
    }

    function applyGameViewMode() {
        var grid = gameViewMode() === 'grid';
        var listEl = $('gameList');
        if (listEl) listEl.classList.toggle('grid-view', grid);
        var gb = $('viewGridBtn'), lb = $('viewListBtn');
        if (gb) gb.classList.toggle('active', grid);
        if (lb) lb.classList.toggle('active', !grid);
    }

    function setGameViewMode(mode) {
        try { localStorage.setItem('pulai.gameView', mode === 'list' ? 'list' : 'grid'); } catch (e) {}
        applyGameViewMode();
        filterGames();
    }

    // Letter tile shown while a cover loads or when every source fails.
    function buildCoverPlaceholder(name) {
        var ph = document.createElement('div');
        ph.className = 'game-cover-ph';
        var letter = (name || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase();
        ph.textContent = letter || '?';
        return ph;
    }

    // Cover tile shared by grid cards. Sources come from shared.js
    // (gameCoverSourcesFor): a gamedata override image (homebrew ports)
    // first, then the Nlib -> tinfoil chain keyed by the file-derived or
    // name-resolved title ID; no ID (or every source failing) leaves the
    // letter tile showing underneath.
    function buildGameCover(g, locked) {
        var cover = document.createElement('div');
        cover.className = 'game-cover';
        cover.appendChild(buildCoverPlaceholder(g.name));
        var sources = gameCoverSourcesFor(g);
        if (sources.length) {
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = g.name;
            coverChain(img, sources);
            cover.appendChild(img);
        }
        // Cover chip uses its own class (absolute, above the image) — the
        // list-style .hot-badge span would sit underneath the cover img and
        // only peek out on cards whose cover failed to load.
        if (state.hotGames && state.hotGames.has(g.name)) {
            const hotN = (state.gameOrderCounts && state.gameOrderCounts[g.name]) || 0;
            const hot = document.createElement('span');
            hot.className = 'game-cover-hot';
            hot.title = 'Popular — ordered in ' + hotN + ' order' + (hotN !== 1 ? 's' : '');
            hot.innerHTML = '&#128293;';
            cover.appendChild(hot);
        }
        if (locked) {
            var lock = document.createElement('span');
            lock.className = 'game-cover-lock';
            lock.innerHTML = '&#128274;';
            cover.appendChild(lock);
        } else {
            var check = document.createElement('span');
            check.className = 'game-cover-check';
            check.innerHTML = '&#10003;';
            cover.appendChild(check);
        }
        // Details (i) button: opens the shared detail panel without touching
        // selection, and works even before storage is configured.
        var info = document.createElement('button');
        info.type = 'button';
        info.className = 'game-cover-info';
        info.title = 'Game details';
        info.setAttribute('aria-label', 'Details: ' + g.name);
        info.textContent = 'i';
        info.onclick = function (e) {
            e.stopPropagation();
            toggleGameDetailFloat(this.closest('.game-card'), g);
        };
        cover.appendChild(info);
        return cover;
    }

    function buildGridMeta(g) {
        const wrap = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'game-cover-name';
        name.textContent = g.name;
        const meta = document.createElement('div');
        meta.className = 'game-cover-meta';
        const size = document.createElement('span');
        size.className = 'game-cover-size';
        size.textContent = `${effectiveGb(g.size)} GB`;
        meta.appendChild(size);
        if (g.fileCount && g.fileCount > 1) {
            const badge = document.createElement('span');
            badge.className = 'game-cover-badge';
            badge.textContent = g.fileCount + ' Games';
            meta.appendChild(badge);
        }
        wrap.appendChild(name);
        wrap.appendChild(meta);
        return wrap;
    }

    function buildGridGameCard(g, isSel) {
        const card = document.createElement('div');
        card.className = 'game-card grid-card' + (isSel ? ' selected' : '');
        card.dataset.gameName = g.name;
        card.dataset.gameSize = g.size;

        card.onclick = (e) => {
            if (!validatePhoneProvided()) return;
            if (!state.isStorageConfigured) { alert('Please enter your available Free Storage Space (GB) at the top before picking games!'); $('userFreeStorageInput').focus(); return; }
            const willSelect = !state.selectedGames.has(g.name);
            let cur = selectedGamesFootprint();
            if (willSelect && state.usableStorageLimit > 0 && (cur + effectiveGb(g.size) > state.usableStorageLimit)) {
                alert(`Cannot add "${g.name}" (${effectiveGb(g.size)} GB after install). It exceeds your available remaining space (${state.usableStorageLimit} GB)!`);
                return;
            }
            toggleGame(g.name, g.size, willSelect, card);
        };

        card.appendChild(buildGameCover(g, false));
        card.appendChild(buildGridMeta(g));
        return card;
    }

    function buildGridHiddenCard(g) {
        const card = document.createElement('div');
        card.className = 'game-card grid-card hidden-game';
        card.appendChild(buildGameCover(g, true));
        card.appendChild(buildGridMeta(g));
        return card;
    }

    function renderGames(list) {
        const container = $('gameList');
        if (!container) return;
        const gridMode = gameViewMode() === 'grid';
        applyGameViewMode();
        container.innerHTML = '';
        // A rebuild invalidates any open detail panel (its nodes just died);
        // drop the scroll-room padding it reserved so no empty gap is left.
        container.style.paddingBottom = '';

        if (!list || list.length === 0) {
            container.innerHTML = '<p style="text-align:center; color:#8a8272;">No games found.</p>';
            return;
        }

        const availableSpace = Math.max(0, state.usableStorageLimit - selectedGamesFootprint());

        const fitting = [], hidden = [];
        list.forEach(g => {
            const isSel = state.selectedGames.has(g.name);
            if (isSel || state.usableStorageLimit <= 0 || effectiveGb(g.size) <= availableSpace) fitting.push(g);
            else hidden.push(g);
        });

        if (hidden.length > 0) {
            const noticeId = 'hiddenNotice_' + Date.now() + Math.random().toString(36).slice(2);
            const notice = document.createElement('div');
            notice.className = 'hidden-games-notice';
            notice.innerHTML = `<div class="hidden-notice-text"><span class="hidden-notice-icon">&#128274;</span><span><strong>${hidden.length}</strong> game${hidden.length !== 1 ? 's' : ''} hidden — won't fit in your remaining <strong>${availableSpace.toFixed(1)} GB</strong>.</span></div><button class="hidden-notice-toggle" onclick="toggleHiddenGames('${noticeId}')">Show</button>`;
            container.appendChild(notice);

            const hiddenContainer = document.createElement('div');
            hiddenContainer.className = 'hidden-games-container' + (gridMode ? ' grid-view' : '');
            hiddenContainer.id = noticeId;
            hiddenContainer.style.display = 'none';

            hidden.sort((a, b) => a.size - b.size);
            hidden.forEach(g => {
                if (gridMode) { hiddenContainer.appendChild(buildGridHiddenCard(g)); return; }
                const card = document.createElement('div');
                card.className = 'game-card hidden-game';
                const count = g.fileCount && g.fileCount > 1 ? g.fileCount + ' Games' : '';
                var badgeHtml = count ? '<span class="game-count-badge">' + count + '</span>' : '';
                card.innerHTML = `<div class="game-info"><span class="game-lock-icon">&#128274;</span><span class="game-title">${g.name}${hotBadgeHtml(g.name)}</span>${badgeHtml}</div><span class="game-size" style="color:#8a8272;">${effectiveGb(g.size)} GB</span>`;
                hiddenContainer.appendChild(card);
            });
            container.appendChild(hiddenContainer);
        }

        if (fitting.length === 0 && hidden.length > 0) {
            const p = document.createElement('p');
            p.style.cssText = 'text-align:center;color:#8a8272;margin:10px 0;';
            if (gridMode) p.style.gridColumn = '1 / -1';
            p.innerText = 'No more games fit in your remaining storage.';
            container.appendChild(p);
        }

        fitting.forEach(g => {
            if (gridMode) { container.appendChild(buildGridGameCard(g, state.selectedGames.has(g.name))); return; }
            const isSel = state.selectedGames.has(g.name);
            const card = document.createElement('div');
            card.className = `game-card ${isSel ? 'selected' : ''}`;
            card.dataset.gameName = g.name;
            card.dataset.gameSize = g.size;

            card.onclick = (e) => {
                if (!validatePhoneProvided()) return;
                if (!state.isStorageConfigured) { alert('Please enter your available Free Storage Space (GB) at the top before picking games!'); $('userFreeStorageInput').focus(); return; }
                const cb = card.querySelector('input');
                if (e.target !== cb) cb.checked = !cb.checked;

                let cur = selectedGamesFootprint();
                if (cb.checked && state.usableStorageLimit > 0 && (cur + effectiveGb(g.size) > state.usableStorageLimit)) {
                    alert(`Cannot add "${g.name}" (${effectiveGb(g.size)} GB after install). It exceeds your available remaining space (${state.usableStorageLimit} GB)!`);
                    cb.checked = false;
                    return;
                }
                toggleGame(g.name, g.size, cb.checked, card);
            };

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isSel;
            cb.onclick = (e) => e.stopPropagation();
            cb.onchange = () => {
                if (!validatePhoneProvided()) { cb.checked = false; return; }
                if (!state.isStorageConfigured) { alert('Please enter your available Free Storage Space (GB) first!'); cb.checked = false; $('userFreeStorageInput').focus(); return; }
                let cur = selectedGamesFootprint();
                if (cb.checked && state.usableStorageLimit > 0 && (cur + effectiveGb(g.size) > state.usableStorageLimit)) {
                    alert(`Cannot add "${g.name}" (${effectiveGb(g.size)} GB after install). It exceeds your remaining usable storage (${state.usableStorageLimit} GB)!`);
                    cb.checked = false;
                    return;
                }
                toggleGame(g.name, g.size, cb.checked, card);
            };

            const infoDiv = document.createElement('div');
            infoDiv.className = 'game-info';
            infoDiv.appendChild(cb);
            const titleSpan = document.createElement('span');
            titleSpan.className = 'game-title';
            const count = g.fileCount && g.fileCount > 1 ? g.fileCount + ' Games' : '';
            titleSpan.textContent = g.name;
            titleSpan.insertAdjacentHTML('beforeend', hotBadgeHtml(g.name));
            if (count) {
                var badge = document.createElement('span');
                badge.className = 'game-count-badge';
                badge.textContent = count;
                titleSpan.appendChild(badge);
            }
            infoDiv.appendChild(titleSpan);
            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'game-size';
            sizeSpan.textContent = `${effectiveGb(g.size)} GB`;

            card.appendChild(infoDiv);
            card.appendChild(sizeSpan);
            // Details (i) button for compact rows — same shared panel.
            const rowInfo = document.createElement('button');
            rowInfo.type = 'button';
            rowInfo.className = 'game-row-info';
            rowInfo.title = 'Game details';
            rowInfo.setAttribute('aria-label', 'Details: ' + g.name);
            rowInfo.textContent = 'i';
            rowInfo.onclick = (e) => { e.stopPropagation(); toggleGameDetailFloat(card, g); };
            card.appendChild(rowInfo);
            container.appendChild(card);
        });
    }

    function toggleHiddenGames(containerId) {
        const c = $(containerId);
        if (!c) return;
        const notice = c.previousElementSibling;
        const btn = notice ? notice.querySelector('.hidden-notice-toggle') : null;
        if (c.style.display === 'none') {
            c.style.display = c.classList.contains('grid-view') ? 'grid' : 'flex';
            if (btn) btn.textContent = 'Hide';
        }
        else { c.style.display = 'none'; if (btn) btn.textContent = 'Show'; }
    }

    function toggleGame(name, size, isChecked, cardEl) {
        if (isChecked) { state.selectedGames.set(name, size); if (cardEl) cardEl.classList.add('selected'); }
        else { state.selectedGames.delete(name); if (cardEl) cardEl.classList.remove('selected'); }
        updateStorageBreakdownAndCart();
        scheduleGamesRerender();
    }

    function sortGames(list, mode) {
        const counts = state.gameOrderCounts || {};
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', numeric: true });
        if (mode === 'za') return list.sort((a, b) => byName(b, a));
        if (mode === 'popular') {
            return list.sort((a, b) => ((counts[b.name] || 0) - (counts[a.name] || 0)) || byName(a, b));
        }
        if (mode === 'rating') {
            const score = g => { const d = gameDataFor(g); return (d && d.m !== undefined) ? d.m : -1; };
            return list.sort((a, b) => (score(b) - score(a)) || byName(a, b));
        }
        return list.sort(byName);
    }

    function filterGames() {
        const input = $('searchInput');
        if (!input) return;
        const query = input.value.toLowerCase();
        $('clearSearchBtn').style.display = query.length > 0 ? 'block' : 'none';
        const source = typeof games !== 'undefined' ? games : [];
        const filtered = source.filter(g => g.name.toLowerCase().includes(query));
        const sortMode = $('sortGames') ? $('sortGames').value : 'az';
        sortGames(filtered, sortMode);
        renderGames(filtered);
    }

    function clearSearch() {
        $('searchInput').value = '';
        $('clearSearchBtn').style.display = 'none';
        filterGames();
    }

    function calculatePriceDetails(count, totalGb) {
        // Delegates to the shared pricing engine in config.js so admin.html can
        // recompute an identical subtotal when applying free games / discounts.
        return computePricing({
            serviceType: valOf('serviceTypeSelect'),
            consoleModel: valOf('consoleModelSelect'),
            count: count,
            totalGb: totalGb,
            freeGames: state.freeGamesCount,
            repairs: Array.from(state.selectedRepairs.values()),
            hasAndroid: !!$('androidModeCheck') && $('androidModeCheck').checked,
            hasLinux: !!$('linuxModeCheck') && $('linuxModeCheck').checked,
            sdSource: valOf('sdSourceSelect'),
            maxSdSize: state.maxSdSize
        });
    }

    function checkTierRecommendation(count, serviceType) {
        const empty = { hasWarning: false, targetCount: 0, remaining: 0, msg: '', nudge: '' };
        if (!serviceType) return empty;
        if (count === 0) return empty;
        const hasFree = (serviceType === 'jailbreak' || serviceType === 'system_setup');

        if (hasFree) {
            if (count < 3) return { hasWarning: true, targetCount: 3, remaining: 3 - count, msg: `<strong>Free Games Available:</strong> You selected <strong>${count} game(s)</strong>. Your package includes <strong>3 games at no extra cost</strong> — you can select <strong>${3 - count} more</strong>.`, nudge: '' };
            if (count === 3) return empty;
            if (count > 13 && count < 23) { const rem = 23 - count; return { hasWarning: true, targetCount: 23, remaining: rem, msg: `Add <strong>${rem} more games</strong> to unlock the RM2.50/game rate.`, nudge: { remaining: rem, rate: 'RM2.50' } }; }
            if (count === 23) return empty;
            if (count > 23 && count < 43) { const rem = 43 - count; return { hasWarning: true, targetCount: 43, remaining: rem, msg: `Add <strong>${rem} more games</strong> to unlock the RM2/game rate.`, nudge: { remaining: rem, rate: 'RM2' } }; }
            if (count === 43) return empty;
            return empty;
        }

        if (count > 10 && count < 20) { const rem = 20 - count; return { hasWarning: true, targetCount: 20, remaining: rem, msg: `Add <strong>${rem} more games</strong> to unlock the RM2.50/game rate.`, nudge: { remaining: rem, rate: 'RM2.50' } }; }
        if (count === 20) return empty;
        if (count > 20 && count < 40) { const rem = 40 - count; return { hasWarning: true, targetCount: 40, remaining: rem, msg: `Add <strong>${rem} more games</strong> to unlock the RM2/game rate.`, nudge: { remaining: rem, rate: 'RM2' } }; }
        if (count === 40) return empty;
        return empty;
    }

    function updateCartSummary() {
        const gameNames = Array.from(state.selectedGames.keys());
        const count = gameCountTotal(gameNames);
        const serviceType = valOf('serviceTypeSelect');
        let gSize = 0;
        state.selectedGames.forEach(s => gSize += s);
        const footprint = selectedGamesFootprint();
        const remainder = Math.max(0, state.usableStorageLimit - footprint);
        const details = calculatePriceDetails(count, gSize);
        const repairInfo = getSelectedRepairTotal();

        $('selectedCount').innerText = count;
        $('selectedSize').innerText = footprint.toFixed(1);
        $('remainderSize').innerText = remainder.toFixed(1);
        $('selectedPrice').innerText = 'RM' + Math.max(0, Math.round(details.subtotal) - state.discountRm);

        // Repair summary line in checkout bar
        const rSummary = $('checkoutRepairSummary');
        if (repairInfo.count > 0) {
            rSummary.innerHTML = ' | <span style="color:#ffb74d; font-weight:bold;">' + repairInfo.count + ' repair' + (repairInfo.count === 1 ? '' : 's') + (repairInfo.quoteCount > 0 ? ' (+' + repairInfo.quoteCount + ' quote)' : '') + '</span>';
        } else {
            rSummary.innerHTML = '';
        }

        const tierRec = checkTierRecommendation(count, serviceType);
        const banner = $('tierWarningBanner');
        if (tierRec.hasWarning && tierRec.msg) { banner.style.display = 'flex'; $('tierWarningText').innerHTML = tierRec.msg; }
        else banner.style.display = 'none';

        const sub = $('checkoutSubtext');
        let subHtml = '';
        if (serviceType === 'repair_only') {
            subHtml = repairInfo.count === 0 ? 'Select your repairs above' : 'Tap to review and add remarks';
        } else if (tierRec.hasWarning && tierRec.nudge) {
            subHtml = '<span class="checkout-nudge-action">Add ' + tierRec.nudge.remaining + ' more</span> — ' + tierRec.nudge.rate + '/game rate · Tap to review';
        } else if (tierRec.hasWarning && tierRec.remaining > 0 && (serviceType === 'jailbreak' || serviceType === 'system_setup') && count < 3) {
            subHtml = `(${count} free games selected, ${tierRec.remaining} more available) · Tap to review`;
        } else if (serviceType === 'jailbreak' || serviceType === 'system_setup') {
            if (count === 0) subHtml = 'Package includes 3 games at no extra cost. Tap here to review & add remarks';
            else if (count <= 3) subHtml = `(${count} free games selected, ${3 - count} more available) · Tap to review`;
            else { const c = count - 3; subHtml = `(3 included + ${c} addon${c !== 1 ? 's' : ''}) · Tap to review`; }
        } else {
            subHtml = 'Tap here to review & add remarks';
        }
        sub.innerHTML = subHtml;
    }

    // Status-only view of whatever is on this phone number. It cannot load an
    // order into the form: that would mean handing over the whole order to
    // anyone who can guess 4 digits. The private link is the only way in, and
    // orders_by_phone deliberately returns just enough to recognise an order.
    async function fetchExistingOrder() {
        const input = $('phoneInput');
        const phone = input.value.trim();
        const btn = $('loadOrderBtn');
        const btnText = $('loadOrderText');
        const btnIcon = $('loadOrderIcon');

        if (phone.length !== 4) {
            alert('"Load Order" is for returning customers who want to check an order they placed before.\n\nPlease enter the last 4 digits of your phone number first.');
            input.focus();
            input.classList.add('required-missing');
            return;
        }

        const origText = btnText.textContent, origIcon = btnIcon.textContent;
        btn.disabled = true;
        btnIcon.textContent = '\u23F3';
        btnText.textContent = 'Searching...';
        setStatusMessage('Searching for your saved orders...', '#7dd3fc', 0);

        try {
            const { data, error } = await supabaseClient.rpc('orders_by_phone', { p_phone: phone });
            if (error) throw error;
            const orders = Array.isArray(data) ? data : [];

            if (orders.length === 0) {
                state.currentEditingOrderId = null;
                state.currentEditingToken = null;
                state.currentLoadedPhone = null;
                hideEditModeBanner();
                alert(`No previous order found for phone "${phone}".\n\nYou can start a new order below.`);
                setStatusMessage('No order found. Start a new order below.', '#ffb74d', 5000);
                return;
            }

            showFoundOrdersByPhone(phone, orders);
        } catch (err) {
            console.error(err);
            setStatusMessage('Failed to lookup order.', '#e57373', 5000);
        } finally {
            btn.disabled = false;
            btnIcon.textContent = origIcon;
            btnText.textContent = origText;
        }
    }

    const SERVICE_LABELS = {
        'jailbreak': 'Full Jailbreak', 'system_setup': 'System Setup',
        'games_only': 'Games Only', 'system_update': 'System Update',
        'repair_only': 'Repair Only'
    };

    const INACTIVE_STATUSES = ['Completed', 'Cancelled'];

    function stagePillClass(stage, status) {
        if (status === 'Cancelled' || stage === 'Cancelled') return 'cancelled';
        if (status === 'Completed' || stage === 'Completed') return 'completed';
        if (stage === 'In Progress') return 'in-progress';
        if (stage === 'Confirmed') return 'confirmed';
        return '';
    }

    // A phone lookup returns status-only records, so these rows are labelled
    // "Order 1", "Order 2" rather than by order number - the number is not part
    // of what a phone lookup is allowed to reveal. They are deliberately not
    // clickable: opening an order needs the private token, which this lookup
    // never sees.
    function showFoundOrdersByPhone(phone, orders) {
        dismissFoundOrdersNotice();

        const dateOpts = { day: 'numeric', month: 'short', year: 'numeric' };
        let n = 0;
        const row = function (o) {
            n++;
            const when = o.created_at ? new Date(o.created_at).toLocaleDateString('en-MY', dateOpts) : 'unknown date';
            const label = SERVICE_LABELS[o.service_type] || 'Order';
            const model = o.console_model ? ' (' + escapeHtml(o.console_model) + ')' : '';
            const stage = o.progress_stage || 'Order Received';
            const status = o.status || 'Pending';
            const pill = stagePillClass(stage, status);
            return '<div class="order-pick-item readonly">'
                + '<div class="order-pick-item-header">'
                + '  <div class="order-pick-id">Order ' + n + ' &middot; ' + escapeHtml(label) + model + '</div>'
                + '  <span class="order-pick-stage-pill ' + pill + '">' + escapeHtml(stage) + '</span>'
                + '</div>'
                + '<div class="order-pick-detail">' + escapeHtml(status) + ' &middot; placed ' + escapeHtml(when) + '</div>'
                + '</div>';
        };

        const active = orders.filter(function (o) { return INACTIVE_STATUSES.indexOf(o.status || 'Pending') === -1; });
        const past = orders.filter(function (o) { return INACTIVE_STATUSES.indexOf(o.status || 'Pending') !== -1; });

        let list = '';
        if (active.length) {
            list += '<div class="order-pick-group">Active</div>' + active.map(row).join('');
        }
        if (past.length) {
            list += '<div class="order-pick-group">Finished</div>' + past.map(row).join('');
        }

        const trackUrl = window.location.origin + window.location.pathname.replace('index.html', 'track.html') + '?phone=' + encodeURIComponent(phone);
        const waNumber = getWhatsAppNumber();
        const waText = encodeURIComponent("Hi, I can't find the private link for my order (phone ending " + phone + '). Could you send it to me?');

        const panel = document.createElement('div');
        panel.className = 'missing-order-notice found-orders-panel';
        panel.innerHTML = ''
            + '<button class="missing-order-close" onclick="dismissFoundOrdersNotice()" aria-label="Close">&#10005;</button>'
            + '<div class="missing-order-title">We found ' + orders.length + ' order' + (orders.length > 1 ? 's' : '') + ' on this number</div>'
            + '<div class="missing-order-body">'
            + 'For everyone\'s privacy, a phone number only ever shows progress &mdash; not the order itself. '
            + 'To see full details or make changes, open the private link we sent you.'
            + '</div>'
            + '<div class="order-pick-list">' + list + '</div>'
            + '<div class="missing-order-actions">'
            + (active.length
                ? '  <a class="missing-order-btn secondary" href="' + trackUrl + '">Check progress</a>'
                : '')
            + '  <button class="missing-order-btn secondary" onclick="dismissFoundOrdersNotice()">&#10024; Start a new order</button>'
            + (waNumber
                ? '  <a class="missing-order-btn whatsapp" href="https://wa.me/' + waNumber + '?text=' + waText + '" target="_blank" rel="noopener noreferrer">Send me my link</a>'
                : '')
            + '</div>';

        attachNoticeBackdrop(panel);
        const bar = $('checkoutBar');
        if (bar) bar.classList.add('hidden');
        setStatusMessage('Found your order. Open your private link to view or change it.', '#00e676', 8000);
    }

    // Every .missing-order-notice card behaves like a modal, so they all need
    // the same backdrop: it freezes the page underneath (BodyLock fixes the body
    // in place so the scroll position is not lost) and swallows a tap outside.
    // Without it the page behind scrolls under the card and there is no obvious
    // way out.
    function attachNoticeBackdrop(panel, onOutsideTap) {
        document.querySelectorAll('.notice-backdrop').forEach(function (el) { el.remove(); });
        const backdrop = document.createElement('div');
        backdrop.className = 'notice-backdrop';
        backdrop.addEventListener('click', function () {
            if (typeof onOutsideTap === 'function') onOutsideTap();
            else dismissFoundOrdersNotice();
        });
        document.body.appendChild(backdrop);
        document.body.appendChild(panel);
        BodyLock.lock();
    }

    // Escape has to work too, but only for these cards: the cart modal and the
    // remarks modal are separate flows and must keep their own behaviour.
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' && e.key !== 'Esc') return;
        if (!document.querySelector('.missing-order-notice')) return;
        const card = document.querySelector('.missing-order-notice');
        if (card.classList.contains('found-orders-panel')) dismissFoundOrdersNotice();
        else dismissMissingOrderNotice();
    });

    // Removes whichever "card" notice is on screen. These cards are mutually
    // exclusive by nature, and they all share .missing-order-notice, so this
    // clears every one of them rather than only our own.
    function dismissFoundOrdersNotice() {
        const cards = document.querySelectorAll('.missing-order-notice');
        const backdrops = document.querySelectorAll('.notice-backdrop');
        cards.forEach(function (el) { el.remove(); });
        backdrops.forEach(function (el) { el.remove(); });
        if (backdrops.length) BodyLock.unlock();
        const bar = $('checkoutBar');
        if (bar) bar.classList.remove('hidden');
    }

    function applyLoadedOrder(order) {
        state.selectedGames.clear();
        state.selectedRepairs.clear();
        const source = typeof games !== 'undefined' ? games : [];

        if (order.games && Array.isArray(order.games)) {
            order.games.forEach(name => {
                const found = source.find(g => g.name === name);
                state.selectedGames.set(name, found ? found.size : 0);
            });
        }

        // Load repairs (snapshot objects)
        if (order.repairs && Array.isArray(order.repairs)) {
            order.repairs.forEach(r => {
                if (r && typeof r === 'object' && r.id) {
                    state.selectedRepairs.set(r.id, {
                        id: r.id,
                        name: r.name || r.id,
                        category: r.category || '',
                        price: Number(r.price) || 0,
                        isQuote: !!r.is_quote,
                        note: r.note || ''
                    });
                } else if (typeof r === 'string') {
                    // Legacy id-only
                    const svc = (window.REPAIR_SERVICES || []).find(s => s.id === r);
                    if (svc) {
                        const p = computeRepairPrice(svc, order.console_model || 'OLED');
                        state.selectedRepairs.set(svc.id, {
                            id: svc.id, name: svc.name, category: svc.category || '',
                            price: p.amount, isQuote: p.isQuote, note: svc.note || ''
                        });
                    }
                }
            });
        }

        if (order.remarks) state.savedRemarksText = order.remarks;
        if (order.service_type) $('serviceTypeSelect').value = order.service_type;
        if (order.sd_source) $('sdSourceSelect').value = order.sd_source;
        populateSdCardOptions();
        if (order.sd_card_size) {
            const sel = $('sdCardSelect');
            if (sel.querySelector(`option[value="${order.sd_card_size}"]`)) {
                sel.value = order.sd_card_size;
                state.maxSdSize = parseInt(order.sd_card_size);
            }
        }
        if (order.free_storage_gb) $('userFreeStorageInput').value = order.free_storage_gb;
        if (order.console_model) $('consoleModelSelect').value = order.console_model;
        $('androidModeCheck').checked = !!order.android_mode;
        $('linuxModeCheck').checked = !!order.linux_mode;
        toggleServiceFields();
        updateSdLimit();
        filterGames();
        if (state.selectedGames.size > 0 && order.service_type !== 'repair_only') revealGameSection();
        // Expand repair section if repairs exist
        if (state.selectedRepairs.size > 0 && !state.repairSectionExpanded) {
            state.repairSectionExpanded = true;
            $('repairBody').classList.add('expanded');
            $('repairToggleLabel').textContent = 'Hide';
        }
        renderRepairSection();
        showEditModeBanner();
        updateSaveButtonLabel();
    }

    function updateSaveButtonLabel() {
        const btn = $('modalSaveBtn');
        if (!btn) return;
        btn.textContent = state.currentEditingOrderId ? 'Save Changes' : 'Place Order';
    }

    // Whether the form has enough filled in to open the review modal.
    // state.isStorageConfigured means "the customer has typed a free-space
    // number", which is what the game list needs in order to cap a selection.
    // It is deliberately not reused here: on a System Update the games are
    // optional, so a blank storage box must not stop someone booking the
    // update on its own.
    function canProceedToReview() {
        if (valOf('serviceTypeSelect') === 'system_update') return true;
        return state.isStorageConfigured;
    }

    function openCartModal() {
        if (!validatePhoneProvided()) return;
        if (!canProceedToReview()) { alert('Please complete your configuration (service type, model, storage) before proceeding!'); return; }
        const serviceType = valOf('serviceTypeSelect');
        if (serviceType === 'repair_only' && state.selectedRepairs.size === 0) {
            alert('Please select at least one repair to continue.');
            return;
        }
        renderCartModalContent();
        $('cartModal').style.display = 'flex';
        BodyLock.lock();
    }

    function renderCartModalContent() {
        const body = $('cartModalBody');
        if (!body) return;
        body.innerHTML = '';

        const serviceType = valOf('serviceTypeSelect');
        const consoleModel = valOf('consoleModelSelect');
        const sdSource = valOf('sdSourceSelect');
        const freeStorage = valOf('userFreeStorageInput');
        const android = $('androidModeCheck').checked;
        const linux = $('linuxModeCheck').checked;
        const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');
        const isRepairOnly = serviceType === 'repair_only';

        const gameNames2 = Array.from(state.selectedGames.keys());
        const count = gameCountTotal(gameNames2);
        let gSize = 0;
        state.selectedGames.forEach(s => gSize += s);
        const footprint = selectedGamesFootprint();
        const details = calculatePriceDetails(count, gSize);

        // ===== 1. Service & Hardware =====
        const h1 = document.createElement('div');
        h1.className = 'modal-section-title';
        h1.textContent = '1. Service & Hardware';
        body.appendChild(h1);

        let serviceLabel = 'Games Installation Service';
        let serviceSub = `Client-Stated Free Space: ${freeStorage || 0} GB`;
        let servicePrice = details.serviceBasePrice;
        // True only when a fee that exists was taken off (repair bench fee with a
        // paid repair). Games Only has no base fee at all, so its zero price is
        // normal and must not read as a discount.
        let serviceFeeWaived = false;
        if (serviceType === 'jailbreak') { serviceLabel = `Full Jailbreak (${consoleModel})`; serviceSub = 'Console modification + 3 games included'; }
        else if (serviceType === 'system_setup') { serviceLabel = 'System Setup'; serviceSub = 'Console modding & configuration + 3 games included'; }
        else if (serviceType === 'system_update') { serviceLabel = 'System Update'; serviceSub = 'Update existing mod — no SD config needed'; }
        else if (serviceType === 'repair_only') {
            serviceLabel = 'Repair Service';
            const hasPaid = Array.from(state.selectedRepairs.values()).some(r => !r.isQuote && r.id !== 'diagnostic');
            serviceSub = hasPaid ? 'Bench fee waived (paid repair selected)' : 'Diagnostic / bench fee';
            if (hasPaid) { servicePrice = 0; serviceFeeWaived = true; }
        }

        const serviceRight = servicePrice > 0
            ? `<div style="display:flex; align-items:center; gap:8px; flex-shrink:0;"><span style="font-weight:bold; color:#ffc000;">RM${servicePrice}</span></div>`
            : (serviceFeeWaived ? '<span class="lock-badge">Waived</span>' : '<span class="lock-badge">No service fee</span>');

        const sItem = document.createElement('div');
        sItem.className = 'cart-item fixed-item';
        sItem.innerHTML = `<div class="cart-item-details"><span class="cart-item-title">${serviceLabel}</span><span class="cart-item-sub">${serviceSub}</span></div>${serviceRight}`;
        body.appendChild(sItem);

        if (isJbOrSetup) {
            const sdLabel = state.maxSdSize >= 1000 ? `${(state.maxSdSize / 1024).toFixed(0)}TB` : `${state.maxSdSize}GB`;
            const sdItem = document.createElement('div');
            sdItem.className = 'cart-item';
            if (sdSource === 'buy') {
                sdItem.innerHTML = `<div class="cart-item-details"><span class="cart-item-title">Purchase ${sdLabel} SD Card</span><span class="cart-item-sub">Brand new pre-configured card</span></div><div style="display:flex; align-items:center; gap:8px; flex-shrink:0;"><span style="font-weight:bold; color:#ffc000;">+RM${details.sdCardPrice}</span><button class="remove-btn" onclick="removeAddonFromCart('sdcard')">Remove</button></div>`;
            } else {
                sdItem.innerHTML = `<div class="cart-item-details"><span class="cart-item-title">Bring Own SD Card (${sdLabel})</span><span class="cart-item-sub">Provided by customer</span></div><span class="lock-badge">Free</span>`;
            }
            body.appendChild(sdItem);

            if (android) {
                const aItem = document.createElement('div');
                aItem.className = 'cart-item';
                aItem.innerHTML = `<div class="cart-item-details"><span class="cart-item-title">Android Mode</span><span class="cart-item-sub">LineageOS dual-boot setup</span></div><div style="display:flex; align-items:center; gap:8px; flex-shrink:0;"><span style="font-weight:bold; color:#ffc000;">+RM${details.androidPrice}</span><button class="remove-btn" onclick="removeAddonFromCart('android')">Remove</button></div>`;
                body.appendChild(aItem);
            }
            if (linux) {
                const lItem = document.createElement('div');
                lItem.className = 'cart-item';
                lItem.innerHTML = `<div class="cart-item-details"><span class="cart-item-title">Linux Mode</span><span class="cart-item-sub">Ubuntu Linux desktop environment</span></div><div style="display:flex; align-items:center; gap:8px; flex-shrink:0;"><span style="font-weight:bold; color:#ffc000;">+RM${details.linuxPrice}</span><button class="remove-btn" onclick="removeAddonFromCart('linux')">Remove</button></div>`;
                body.appendChild(lItem);
            }
        }

        // ===== 2. Repairs =====
        if (state.selectedRepairs.size > 0) {
            const hRep = document.createElement('div');
            hRep.className = 'modal-section-title';
            hRep.textContent = '2. Repair Jobs';
            body.appendChild(hRep);

            state.selectedRepairs.forEach(r => {
                const item = document.createElement('div');
                item.className = 'cart-item repair-cart-item';
                item.innerHTML = `
                    <div class="cart-item-details">
                        <span class="cart-item-title">${escapeHtml(r.name)}</span>
                        <span class="cart-item-sub">${r.note ? escapeHtml(r.note) : (r.category || 'Repair')}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                        <span style="font-weight:bold; ${r.isQuote ? 'color:#ffb74d;font-style:italic;font-size:11.5px;' : 'color:#ffc000;'}">${r.isQuote ? 'TBC' : 'RM' + r.price}</span>
                        <button class="remove-btn" onclick="removeRepairFromCart('${escapeHtml(r.id)}')">Remove</button>
                    </div>
                `;
                body.appendChild(item);
            });
        }

        // ===== 3. Selected Games =====
        if (!isRepairOnly) {
            const h2 = document.createElement('div');
            h2.className = 'modal-section-title';
            h2.textContent = (state.selectedRepairs.size > 0 ? '3' : '2') + '. Selected Games';
            body.appendChild(h2);

            const tierRec = checkTierRecommendation(count, serviceType);
            if (tierRec.hasWarning && tierRec.msg) {
                const banner = document.createElement('div');
                banner.className = 'modal-alert warning';
                banner.style.display = 'block';
                banner.innerHTML = tierRec.msg;
                body.appendChild(banner);
            }

            const gamesDetails = document.createElement('details');
            gamesDetails.className = 'cart-details';
            if (state.modalGamesExpanded) gamesDetails.open = true;

            const gamesSummary = document.createElement('summary');
            gamesSummary.className = 'cart-details-summary';
            gamesSummary.innerHTML = `<span>Selected Games (${count} · ${footprint.toFixed(1)} GB${installBufferNote()})</span><span class="chev">▼</span>`;
            gamesDetails.appendChild(gamesSummary);

            const gamesBody = document.createElement('div');
            gamesBody.className = 'cart-details-body';
            if (state.selectedGames.size === 0) {
                const p = document.createElement('p');
                p.style.cssText = 'text-align:center; color:#8a8272; margin:5px 0; font-size:13px;';
                p.textContent = isJbOrSetup ? 'No games selected yet (3 games included in package)' : 'No games selected.';
                gamesBody.appendChild(p);
            } else {
                let idx = 1;
                const catalog = typeof games !== 'undefined' && Array.isArray(games) ? games : [];
                const catalogMap = {};
                catalog.forEach(g => { catalogMap[g.name] = g; });
                state.selectedGames.forEach((size, name) => {
                    const item = document.createElement('div');
                    item.className = 'cart-item';
                    let tag = '';
                    if (isJbOrSetup) tag = idx <= 3 ? ' <span style="color:#e8dcc0; font-size:10px;">[INCLUDED]</span>' : ' <span style="color:#ffb74d; font-size:10px;">[ADDON]</span>';
                    const g = catalogMap[name];
                    const gCount = g && g.fileCount && g.fileCount > 1 ? g.fileCount + ' Games' : '';
                    const badgeHtml = gCount ? '<span class="game-count-badge">' + gCount + '</span>' : '';
                    const titleSpan = document.createElement('span');
                    titleSpan.innerHTML = `${idx}. ${name}${badgeHtml} ${tag} <span style="color:#ffc000; font-size:0.85em;">(${effectiveGb(size)} GB)</span>`;
                    const btn = document.createElement('button');
                    btn.className = 'remove-btn';
                    btn.textContent = 'Remove';
                    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeGameFromCart(name); };
                    item.appendChild(titleSpan);
                    item.appendChild(btn);
                    gamesBody.appendChild(item);
                    idx++;
                });
            }
            gamesDetails.appendChild(gamesBody);
            gamesDetails.addEventListener('toggle', () => { state.modalGamesExpanded = gamesDetails.open; });
            body.appendChild(gamesDetails);
        }

        // ===== N. Remarks =====
        const hLast = document.createElement('div');
        hLast.className = 'modal-section-title';
        let secNum = 2;
        if (state.selectedRepairs.size > 0) secNum++;
        if (!isRepairOnly) secNum++;
        hLast.textContent = secNum + '. Additional Remarks';
        body.appendChild(hLast);

        const remarksDetails = document.createElement('details');
        remarksDetails.className = 'cart-details';
        if (state.modalRemarksExpanded) remarksDetails.open = true;

        const remarksSummary = document.createElement('summary');
        remarksSummary.className = 'cart-details-summary';
        const hasContent = (state.savedRemarksText || '').trim().length > 0;
        const label = hasContent ? 'Add Remarks · <span style="color:#ffc000; font-size:12px;">(has content)</span>' : 'Add Remarks (Optional)';
        remarksSummary.innerHTML = `<span>${label}</span><span class="chev">▼</span>`;
        remarksDetails.appendChild(remarksSummary);

        const remarksBody = document.createElement('div');
        remarksBody.className = 'cart-details-body';
        const ta = document.createElement('textarea');
        ta.className = 'remarks-input';
        ta.placeholder = 'e.g. describe the issue, specific game DLCs, special requests...';
        ta.value = state.savedRemarksText || '';
        ta.oninput = () => { state.savedRemarksText = ta.value; };
        remarksBody.appendChild(ta);
        remarksDetails.appendChild(remarksBody);
        remarksDetails.addEventListener('toggle', () => { state.modalRemarksExpanded = remarksDetails.open; });
        body.appendChild(remarksDetails);

        // Share link (editing only)
        const shareContainer = $('shareLinkContainer');
        if (state.currentEditingOrderId) {
            shareContainer.style.display = 'block';
            $('shareLinkInput').value = buildShareUrl();
            $('shareLinkDesc').innerHTML = 'This order already exists. Bookmark or share this link to edit it anytime:';
        } else shareContainer.style.display = 'none';

        // ===== Price breakdown =====
        const priceBox = $('modalPriceBreakdown');
        let html = '';
        if (serviceType === 'jailbreak') html += `<div class="price-breakdown-row"><span>Full Jailbreak (${consoleModel})</span><span>RM${details.serviceBasePrice}</span></div>`;
        else if (serviceType === 'system_setup') html += `<div class="price-breakdown-row"><span>System Setup Service</span><span>RM${details.serviceBasePrice}</span></div>`;
        else if (serviceType === 'system_update') html += `<div class="price-breakdown-row"><span>System Update Service</span><span>RM${details.serviceBasePrice}</span></div>`;
        else if (serviceType === 'repair_only') {
            if (details.serviceBasePrice > 0) html += `<div class="price-breakdown-row"><span>Diagnostic / bench fee</span><span>RM${details.serviceBasePrice}</span></div>`;
            else html += `<div class="price-breakdown-row"><span>Diagnostic fee</span><span style="color:#00e676;">Waived</span></div>`;
        }

        if (isJbOrSetup) {
            if (sdSource === 'buy') {
                const label = state.maxSdSize >= 1000 ? `${(state.maxSdSize / 1024).toFixed(0)}TB` : `${state.maxSdSize}GB`;
                html += `<div class="price-breakdown-row"><span>New ${label} SD Card</span><span>RM${details.sdCardPrice}</span></div>`;
            }
            if (android) html += `<div class="price-breakdown-row"><span>Android Mode</span><span>RM${details.androidPrice}</span></div>`;
            if (linux) html += `<div class="price-breakdown-row"><span>Linux Mode</span><span>RM${details.linuxPrice}</span></div>`;
        }

        // Repair rows
        if (state.selectedRepairs.size > 0) {
            state.selectedRepairs.forEach(r => {
                if (r.isQuote) {
                    html += `<div class="price-breakdown-row repair-row quote-row"><span>🔧 ${escapeHtml(r.name)}</span><span>TBC after inspection</span></div>`;
                } else {
                    html += `<div class="price-breakdown-row repair-row"><span>🔧 ${escapeHtml(r.name)}</span><span>RM${r.price}</span></div>`;
                }
            });
        }

        // Games row
        if (!isRepairOnly) {
            if (isJbOrSetup) {
                const c = Math.max(0, count - 3);
                const freePart = state.freeGamesCount > 0 ? `, ${state.freeGamesCount} free` : '';
                html += `<div class="price-breakdown-row"><span>Games (${c} addon${c !== 1 ? 's' : ''}${freePart} · 3 included)</span><span>RM${Math.round(details.gamesPrice)}</span></div>`;
            } else {
                const freePart = state.freeGamesCount > 0 ? ` (${state.freeGamesCount} free)` : '';
                html += `<div class="price-breakdown-row"><span>Games Installation${freePart} (${count} games)</span><span>RM${Math.round(details.gamesPrice)}</span></div>`;
            }
        }

        // Shop-side discount granted in admin.html
        const cartSubtotal = Math.round(details.subtotal);
        const cartTotal = Math.max(0, cartSubtotal - state.discountRm);
        if (state.discountRm > 0) {
            html += `<div class="price-breakdown-row discount-row"><span>Subtotal</span><span>RM${cartSubtotal}</span></div>`;
            html += `<div class="price-breakdown-row discount-row discount-line"><span>Discount</span><span>&minus;RM${Math.min(state.discountRm, cartSubtotal)}</span></div>`;
        }

        html += `<div class="price-breakdown-row total-row"><span>Total${details.repairQuoteCount > 0 ? ' (+' + details.repairQuoteCount + ' quote)' : ''}</span><span style="color:#ffc000;">RM${cartTotal}</span></div>`;
        priceBox.innerHTML = html;

        $('sizeWarningBox').style.display = details.exceeded ? 'block' : 'none';
        updateSaveButtonLabel();
    }

    // The private link. The token is the only thing that opens an order, so it
    // goes nowhere except back to this customer - not into any other request.
    function buildShareUrl() {
        const base = window.location.origin + window.location.pathname;
        return state.currentEditingToken ? `${base}?t=${encodeURIComponent(state.currentEditingToken)}` : '';
    }

    function buildTrackUrl(token) {
        const base = window.location.origin + window.location.pathname.replace('index.html', 'track.html');
        return token ? `${base}?t=${encodeURIComponent(token)}` : '';
    }

    function copyShareLink(btnEl) {
        const input = $('shareLinkInput');
        const value = input.value || '';
        if (!value || value.includes('phone=____')) { alert('Please enter your 4-digit phone number first.'); return; }
        navigator.clipboard.writeText(value).then(() => {
            const orig = btnEl.innerHTML;
            btnEl.innerHTML = 'Copied';
            btnEl.style.background = '#ffc000';
            btnEl.style.color = '#14110a';
            setTimeout(() => {
                btnEl.innerHTML = orig;
                btnEl.style.background = '#7dd3fc';
                btnEl.style.color = '#14110a';
            }, 1800);
        }).catch(err => alert('Failed to copy: ' + err));
    }

    function removeAddonFromCart(kind) {
        if (kind === 'sdcard') $('sdSourceSelect').value = 'own';
        else if (kind === 'android') $('androidModeCheck').checked = false;
        else if (kind === 'linux') $('linuxModeCheck').checked = false;
        updateSdLimit();
        renderCartModalContent();
        updateStorageBreakdownAndCart();
    }

    function removeGameFromCart(name) {
        state.selectedGames.delete(name);
        filterGames();
        updateStorageBreakdownAndCart();
        renderCartModalContent();
    }

    function removeRepairFromCart(id) {
        state.selectedRepairs.delete(id);
        renderRepairSection();
        updateCartSummary();
        renderCartModalContent();
    }

    function closeCartModal() {
        $('cartModal').style.display = 'none';
        BodyLock.unlock();
    }

    

    // Put the token in the address bar. Without this, a refresh or a bookmark
    // after saving drops the customer back on an empty form and the order is
    // only reachable from the copy button above.
    function syncUrlToToken(token) {
        if (!token) return;
        try {
            window.history.replaceState({}, '', window.location.pathname + '?t=' + encodeURIComponent(token));
        } catch (e) { /* history is not essential here */ }
    }


    async function submitOrUpdateOrder() {
        if (!canProceedToReview()) { alert('Please complete your configuration (service type, model, storage) before saving.'); closeCartModal(); return; }

        const serviceType = valOf('serviceTypeSelect');
        if (!serviceType) return alert('Please select a Service Type first.');
        const isRepairOnly = serviceType === 'repair_only';
        const isSystemUpdate = serviceType === 'system_update';

        if (serviceType === 'jailbreak' && !valOf('consoleModelSelect')) return alert('Please select your Console Model.');
        if (isRepairOnly && !valOf('consoleModelSelect')) return alert('Please select your Console Model (needed for repair pricing).');
        if (isRepairOnly && state.selectedRepairs.size === 0) return alert('Please select at least one repair.');

        const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');
        if (isJbOrSetup) {
            if (!valOf('sdSourceSelect')) return alert('Please select your SD Card Source.');
            if (!valOf('sdCardSelect')) return alert('Please select your SD Card Capacity.');
        }
        if (!validatePhoneProvided()) return;

        const phone = valOf('phoneInput').trim();
        const gameNames = Array.from(state.selectedGames.keys());
        const count = gameCountTotal(gameNames);
        const submitLabel = (serviceType === 'jailbreak') ? 'Jailbreak' : 'System Setup';

        const tierRec = checkTierRecommendation(count, serviceType);
        if (tierRec.hasWarning && tierRec.msg) {
            let msg;
            if (isJbOrSetup && count < 3) msg = `You've selected ${count} game(s), but your ${submitLabel} package includes 3 games at no extra cost.\n\nPick ${tierRec.remaining} more to use the full allocation, or save now with ${count} game(s)?`;
            else msg = `You've selected ${count} games.\n\nAdd ${tierRec.remaining} more to unlock the lower rate — every game you've picked gets cheaper.\n\nSave now with ${count} games, or go back and add more?`;
            if (!confirm(msg)) return;
        }

        if (isJbOrSetup && count < 3) {
            if (!confirm(`You have selected only ${count} game(s).\n\nYour ${submitLabel} package includes 3 games at no extra cost. Do you still want to save your order with fewer than 3 games?`)) return;
        } else if (serviceType === 'games_only') {
            const fs = valOf('userFreeStorageInput');
            if (!fs || parseFloat(fs) <= 0) { alert('Please enter your remaining free SD card storage space before submitting!'); $('userFreeStorageInput').focus(); return; }
        } else if (isSystemUpdate) {
            // Free space only required if games were picked
            if (state.selectedGames.size > 0) {
                const fs = valOf('userFreeStorageInput');
                if (!fs || parseFloat(fs) <= 0) { alert('Please enter your free SD card storage space so we can check your games will fit.'); $('userFreeStorageInput').focus(); return; }
            }
        }

        if (state.currentEditingOrderId) {
            if (!confirm('You are EDITING an existing order.\n\nTap OK to update that order with your current selection.\n\nWant to keep BOTH? Cancel this, then tap "Start New Order" instead.')) return;
        }

        const remarksText = (state.savedRemarksText || '').trim();
        const btn = $('modalSaveBtn');
        const isEditing = !!state.currentEditingOrderId;
        btn.innerText = isEditing ? 'Saving...' : 'Placing...';
        btn.disabled = true;
        btn.style.pointerEvents = 'none';

        const consoleModel = valOf('consoleModelSelect');
        const freeStorage = valOf('userFreeStorageInput');
        const sdSource = isJbOrSetup ? valOf('sdSourceSelect') : 'own';
        const androidSel = isJbOrSetup ? $('androidModeCheck').checked : false;
        const linuxSel = isJbOrSetup ? $('linuxModeCheck').checked : false;

        let gSize = 0;
        state.selectedGames.forEach(s => gSize += s);
        const details = calculatePriceDetails(count, gSize);
        const subtotal = Math.round(details.subtotal);

        // Snapshot repairs
        const repairsSnapshot = Array.from(state.selectedRepairs.values()).map(r => ({
            id: r.id,
            name: r.name,
            category: r.category || '',
            price: r.price,
            is_quote: r.isQuote,
            note: r.note || ''
        }));

        try {
            const nowIso = new Date().toISOString();

            // The only columns the public anon key may write. The database
            // rejects anything outside this list with a 401 — see
            // supabase_rls_policies.sql. Keep in sync with the GRANT there.
            const customerEdits = {
                phone_ending: phone,
                games: gameNames,
                total_games: count,
                repairs: repairsSnapshot,
                remarks: remarksText,
                sd_card_size: isJbOrSetup ? state.maxSdSize : null,
                free_storage_gb: (serviceType === 'games_only') ? parseFloat(freeStorage)
                : (isSystemUpdate && freeStorage && parseFloat(freeStorage) > 0) ? parseFloat(freeStorage)
                : null,
                sd_source: sdSource,
                service_type: serviceType,
                console_model: (serviceType === 'jailbreak' || isRepairOnly) ? consoleModel : null,
                total_size_gb: gSize,
                android_mode: androidSel,
                linux_mode: linuxSel,
                updated_at: nowIso
            };

            // Shop-controlled pricing. Sent only when placing a new order, as the
            // customer's own estimate of what it will cost. save_order does not
            // read any of these keys, so on a re-save whatever the shop set - a
            // discount, a free-game waiver, a hand-set repair price - survives
            // the edit untouched. That is enforced by the function's column
            // whitelist, not by this comment.
            const shopPricing = {
                price_subtotal: subtotal,
                discount_rm: state.discountRm,
                free_games_count: state.freeGamesCount,
                estimated_price: Math.max(0, subtotal - state.discountRm)
            };

            if (state.currentEditingToken) {
                const res = await supabaseClient.rpc('save_order', {
                    p_token: state.currentEditingToken,
                    p_order: customerEdits
                });
                if (res.error) throw res.error;
                if (!res.data) {
                    // save_order returns null for an unknown link, for an order
                    // that has already been cancelled, and (since the server
                    // gained the stage check) for an order whose edit window
                    // closed. The message must not pick one.
                    alert('This order can no longer be changed here, so nothing was saved.\n\nThat happens if the order was cancelled, if the edit window has closed, or if the link is no longer valid.\n\nPlease message us on WhatsApp and we will help.');
                    return;
                }
                // Re-render from what the database actually stored, not from what
                // was sent, so the summary shows the shop's real pricing.
                state.currentEditingOrderId = res.data.id;
                state.currentEditingToken = res.data.public_token;
                state.currentLoadedPhone = res.data.phone_ending || null;
                syncUrlToToken(res.data.public_token);
                alert('Order updated successfully.');
            } else {
                const orderData = Object.assign({}, customerEdits, shopPricing, {
                    status: 'Pending',
                    created_at: nowIso,
                    progress_stage: 'Order Received',
                    progress_updated_at: nowIso
                });
                const res = await supabaseClient.rpc('create_order', { p_order: orderData });
                if (res.error) throw res.error;
                if (!res.data || !res.data.public_token) throw new Error('Order was placed but no private link came back. Please message us.');
                state.currentEditingOrderId = res.data.id;
                state.currentEditingToken = res.data.public_token;
                state.currentLoadedPhone = phone;
                syncUrlToToken(res.data.public_token);
                alert('New order saved successfully.');
            }

            closeCartModal();
            setStatusMessage('Order successfully saved.', '#00e676', 5000);
            showEditModeBanner();
            // Re-read the order so the summary shows what the database actually
            // stored (including the shop's own pricing) and carries the private
            // link inline. Falling back to the form on failure keeps a successful
            // save from being reported as a failure.
            try {
                await loadOrderByToken(state.currentEditingToken);
            } catch (e) {
                hideSummaryShowForm();
            }
            shareOrderViaWhatsApp();
        } catch (err) {
            console.error(err);
            alert('Failed to save order: ' + (err.message || 'Check console details.'));
        } finally {
            btn.innerText = state.currentEditingOrderId ? 'Save Changes' : 'Place Order';
            btn.disabled = false;
            btn.style.pointerEvents = 'auto';
        }
    }

    function shareOrderViaWhatsApp() {
        const phone = valOf('phoneInput').trim();
        const serviceType = valOf('serviceTypeSelect');
        const consoleModel = valOf('consoleModelSelect');
        const sdSource = valOf('sdSourceSelect');
        const android = $('androidModeCheck').checked;
        const linux = $('linuxModeCheck').checked;
        const remarks = (state.savedRemarksText || '').trim();
        const gameNames3 = Array.from(state.selectedGames.keys());
        const count = gameCountTotal(gameNames3);
        let gSize = 0;
        state.selectedGames.forEach(s => gSize += s);
        const details = calculatePriceDetails(count, gSize);
        const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');
        const isRepairOnly = serviceType === 'repair_only';

        let msg = `*New Pulai PC Order*\n`;
        msg += `Phone ID (Last 4): ${phone}\n`;
        let label = 'Games Only';
        if (serviceType === 'jailbreak') label = `Full Jailbreak (${consoleModel})`;
        else if (serviceType === 'system_setup') label = 'System Setup';
        else if (serviceType === 'system_update') label = 'System Update';
        else if (serviceType === 'repair_only') label = `Repair Only (${consoleModel})`;
        msg += `Service Type: ${label}\n`;

        if (isJbOrSetup) {
            const sdLabel = state.maxSdSize >= 1000 ? `${(state.maxSdSize / 1024).toFixed(0)}TB` : `${state.maxSdSize}GB`;
            msg += `SD Card: ${sdLabel} (${sdSource === 'buy' ? 'New Purchase' : 'Own Card'})\n`;
            if (android) msg += `Addon: Android Mode\n`;
            if (linux) msg += `Addon: Linux Mode\n`;
        } else if (serviceType === 'games_only') {
            msg += `Free Storage: ${valOf('userFreeStorageInput') || 0} GB\n`;
        } else if (serviceType === 'system_update') {
            const fs = valOf('userFreeStorageInput');
            if (fs && parseFloat(fs) > 0) msg += `Free Storage: ${fs} GB\n`;
        }

        if (state.selectedRepairs.size > 0) {
            msg += `\n*Repair Jobs:*\n`;
            state.selectedRepairs.forEach(r => {
                msg += `• ${r.name} — ${r.isQuote ? 'TBC after inspection' : 'RM' + r.price}\n`;
            });
        }

        if (!isRepairOnly) msg += `Selected Games: ${count} games (${selectedGamesFootprint().toFixed(1)} GB total${installBufferNote()})\n`;
        if (remarks) msg += `Remarks: ${remarks}\n`;
        // State the total the customer actually gets. The package already bundles
        // 3 games on a jailbreak or system setup, so 7 granted on top reads as 10.
        const freeGamesTotal = state.freeGamesCount + (isJbOrSetup ? INCLUDED_GAME_ALLOWANCE : 0);
        if (freeGamesTotal > 0) msg += `Free Games Included: ${freeGamesTotal}\n`;
        if (state.discountRm > 0) {
            msg += `Subtotal: RM${Math.round(details.subtotal)}\n`;
            msg += `Discount: -RM${Math.min(state.discountRm, Math.round(details.subtotal))}\n`;
        }
        msg += `Total Estimated Price: RM${Math.max(0, Math.round(details.subtotal) - state.discountRm)}`;
        if (details.repairQuoteCount > 0) msg += ` (+${details.repairQuoteCount} quote)`;

        const shareUrl = buildShareUrl();
        const trackUrl = buildTrackUrl(state.currentEditingToken);
        if (shareUrl) msg += `\n\nYour private link - keep this, it is the only way to view or change your order:\n${shareUrl}`;
        if (trackUrl) msg += `\n\nCheck your progress here:\n${trackUrl}`;

        const wa = getWhatsAppNumber();
        if (!wa) return alert('WhatsApp number is not configured in APP_CONFIG.');
        const url = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
        try {
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => document.body.removeChild(a), 100);
        } catch (err) { window.open(url, '_blank'); }
    }
    