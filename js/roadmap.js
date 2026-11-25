'use strict';

// Draws the roadmap as a route map: four lines of work across the four stages.
// The generated lane list stays in the page as the no-script and screen reader source.
(function () {
    const STAGES = [['Done', 5.2], ['In progress', 1.7], ['Next', 2.3], ['Later', 3.2]];
    const NAMES = { check: 'Check', fix: 'Fix', prove: 'Prove', run: 'Run' };
    const SVG = 'http://www.w3.org/2000/svg';

    function start() {
        const map = document.querySelector('.roadmap-map');
        const themes = document.querySelector('.roadmap-themes');
        const detail = document.querySelector('.roadmap-detail');
        const list = document.querySelector('.roadmap-list');
        if (!map || !themes || !detail || !list || typeof ResizeObserver !== 'function') return;
        const items = Array.from(document.querySelectorAll('.roadmap-lane article[data-theme]')).map(article => ({
            id: article.dataset.roadmapItem, theme: article.dataset.theme, short: article.dataset.short,
            lane: article.closest('.roadmap-lane').dataset.lane, article,
            title: article.querySelector('h3').textContent, text: article.querySelector('h3 ~ p:not(.roadmap-status)').textContent
        }));
        if (!items.length) return;
        let focus = null;
        let selected = items.find(item => item.lane === 'In progress') || items[0];
        const tip = document.createElement('div');
        tip.className = 'roadmap-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('aria-label', 'Roadmap map: each stop is one item, by line of work and stage');
        map.append(svg, tip);
        map.hidden = false; themes.hidden = false; detail.hidden = false; detail.tabIndex = -1;
        const wide = window.matchMedia('(min-width: 901px)');
        // On narrow screens the list is the map: titles only, each a real button inside its heading.
        // Wide screens keep plain headings, so the list stays a normal accessible fallback.
        function setCompact(compact) {
            list.classList.toggle('is-compact', compact);
            for (const item of items) {
                const heading = item.article.querySelector('h3');
                const button = heading.querySelector('button');
                if (compact && !button) {
                    const control = document.createElement('button');
                    control.type = 'button'; control.className = 'roadmap-item-button'; control.textContent = item.title;
                    control.setAttribute('aria-pressed', String(item === selected));
                    heading.replaceChildren(control);
                } else if (!compact && button) heading.textContent = item.title;
            }
        }
        const syncList = () => { list.open = !wide.matches; setCompact(!wide.matches); };
        list.addEventListener('click', event => {
            const control = event.target.closest('.roadmap-item-button');
            if (!control) return;
            choose(control.closest('article').dataset.roadmapItem, false);
            detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        syncList(); wide.addEventListener('change', syncList);

        function el(tag, attrs, text) {
            const node = document.createElementNS(SVG, tag);
            for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
            if (text) node.textContent = text;
            return node;
        }

        function showDetail() {
            detail.replaceChildren();
            detail.dataset.theme = selected.theme;
            const head = document.createElement('h3'); head.textContent = selected.title;
            const body = document.createElement('p'); body.textContent = selected.text;
            const link = selected.article.querySelector('a');
            if (link) { body.append(' '); body.append(link.cloneNode(true)); }
            const pill = document.createElement('p'); pill.className = 'roadmap-pill';
            pill.textContent = NAMES[selected.theme] + ' · ' + selected.lane;
            detail.append(head, pill, body);
        }

        function draw() {
            const W = map.clientWidth, H = map.clientHeight;
            if (W < 300 || H < 200) return;
            svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
            svg.replaceChildren();
            const top = 58, left = 86, bottom = 22, total = STAGES.reduce((sum, stage) => sum + stage[1], 0);
            const band = {}; let x = left;
            for (const [lane, weight] of STAGES) {
                const w = (W - left - 12) * weight / total;
                band[lane] = { x, w }; x += w;
                svg.append(el('rect', { x: band[lane].x + 2, y: 8, width: w - 4, height: H - 16, rx: 12, class: 'roadmap-zone', 'data-lane': lane }));
                svg.append(el('text', { x: band[lane].x + 12, y: 32, class: 'roadmap-zone-label' }, lane));
            }
            const rows = Object.keys(NAMES), rowH = (H - top - bottom) / rows.length;
            rows.forEach((theme, row) => {
                const y = top + rowH * row + rowH / 2;
                const group = el('g', { class: 'roadmap-line', 'data-theme': theme, opacity: focus && focus !== theme ? 0.18 : 1 });
                group.append(el('text', { x: 8, y: y + 5, class: 'roadmap-line-label' }, NAMES[theme]));
                const points = [];
                for (const [lane] of STAGES) {
                    const here = items.filter(item => item.theme === theme && item.lane === lane);
                    here.forEach((item, i) => {
                        const offset = here.length > 1 ? (i % 2 ? -1 : 1) * Math.min(14, rowH * 0.12) : 0;
                        points.push({ item, x: band[lane].x + band[lane].w * (i + 1) / (here.length + 1), y: y + offset });
                    });
                }
                if (points.length) {
                    group.append(el('path', { d: `M${left - 8} ${y} L${points[0].x} ${points[0].y}`, class: 'roadmap-track-lead' }));
                    group.append(el('path', { d: points.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' '), class: 'roadmap-track' }));
                    const lastDone = points.filter(p => p.item.lane === 'Done').pop(), future = points.filter(p => p.item.lane !== 'Done');
                    if (lastDone && future.length) group.append(el('path', { d: `M${lastDone.x} ${lastDone.y} ` + future.map(p => `L${p.x} ${p.y}`).join(' '), class: 'roadmap-track-planned' }));
                }
                for (const point of points) {
                    const { item } = point, on = item === selected;
                    const stop = el('g', { class: 'roadmap-stop', tabindex: 0, role: 'button', 'data-id': item.id, 'data-lane': item.lane,
                        'aria-label': `${item.title}, ${item.lane}`, 'aria-pressed': String(on) });
                    if (item.lane === 'In progress') stop.append(el('circle', { cx: point.x, cy: point.y, r: 9, class: 'roadmap-pulse' }));
                    stop.append(el('circle', { cx: point.x, cy: point.y, r: 20, class: 'roadmap-hit' }));
                    if (on) stop.append(el('circle', { cx: point.x, cy: point.y, r: 16, class: 'roadmap-selected' }));
                    stop.append(el('circle', { cx: point.x, cy: point.y, r: 9, class: 'roadmap-dot' }));
                    if (item.lane !== 'Done' || W >= 1100) {
                        stop.append(el('text', { x: point.x, y: point.y >= y ? point.y + 26 : point.y - 18, class: 'roadmap-stop-label' + (on ? ' is-selected' : '') }, item.short));
                    }
                    group.append(stop);
                }
                svg.append(group);
            });
        }

        function showTip(stop) {
            const item = items.find(i => i.id === stop.dataset.id);
            if (!item) return;
            tip.replaceChildren();
            const strong = document.createElement('strong'); strong.textContent = item.title;
            tip.append(strong, document.createTextNode(item.text));
            tip.hidden = false;
            const box = stop.getBoundingClientRect(), frame = map.getBoundingClientRect();
            const leftEdge = Math.max(8, Math.min(box.left - frame.left + box.width / 2 - 140, frame.width - 288));
            const above = box.top - frame.top > frame.height / 2;
            tip.style.left = leftEdge + 'px';
            tip.style.top = (above ? box.top - frame.top - tip.offsetHeight - 10 : box.bottom - frame.top + 10) + 'px';
        }

        function choose(id, refocus) {
            selected = items.find(item => item.id === id) || selected;
            for (const each of items) {
                each.article.classList.toggle('is-selected', each === selected);
                const control = each.article.querySelector('.roadmap-item-button');
                if (control) control.setAttribute('aria-pressed', String(each === selected));
            }
            showDetail(); draw();
            if (refocus) { const again = svg.querySelector(`[data-id="${id}"]`); if (again) again.focus(); }
        }

        svg.addEventListener('mouseover', event => { const stop = event.target.closest('.roadmap-stop'); if (stop) showTip(stop); });
        svg.addEventListener('mouseout', event => { if (event.target.closest('.roadmap-stop')) tip.hidden = true; });
        svg.addEventListener('focusin', event => { const stop = event.target.closest('.roadmap-stop'); if (stop) showTip(stop); });
        svg.addEventListener('focusout', () => { tip.hidden = true; });
        svg.addEventListener('click', event => { const stop = event.target.closest('.roadmap-stop'); if (stop) choose(stop.dataset.id, false); });
        svg.addEventListener('keydown', event => {
            const stop = event.target.closest('.roadmap-stop');
            if (stop && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(stop.dataset.id, true); }
        });
        themes.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;
            focus = focus === button.dataset.theme ? null : button.dataset.theme;
            for (const each of themes.querySelectorAll('button')) each.setAttribute('aria-pressed', String(each.dataset.theme === focus));
            for (const article of items) article.article.hidden = Boolean(focus) && article.theme !== focus;
            draw();
        });
        const observer = new ResizeObserver(draw);
        observer.observe(map);
        showDetail();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
