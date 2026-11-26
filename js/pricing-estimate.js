'use strict';
(function () {
    // Managed IT estimate: reads the published per-user rates from the plan cards, so the page has one source of prices.
    const form = document.querySelector('.it-estimate');
    if (!form) return;
    const tiers = [...document.querySelectorAll('.managed-it-tier')].map(tier => ({
        name: tier.querySelector('h3')?.textContent.trim() || '',
        rate: Number((tier.querySelector('.managed-it-tier-amount')?.textContent.match(/NZ\$([\d,]+)/) || [])[1]?.replace(/,/g, '')),
        recommended: tier.classList.contains('is-recommended')
    })).filter(tier => tier.name && Number.isFinite(tier.rate));
    if (!tiers.length) return;
    const extraComputer = Number(form.dataset.extraComputer) || 0;
    const extraLocation = Number(form.dataset.extraLocation) || 0;
    const bars = form.querySelector('.it-estimate-bars');
    const money = value => 'NZ$' + value.toLocaleString('en-NZ') + ' + GST';
    const read = (name, min, max) => {
        const value = Math.round(Number(form.elements[name].value));
        return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
    };
    const rows = tiers.map(tier => {
        const li = document.createElement('li');
        if (tier.recommended) li.classList.add('is-recommended');
        const label = document.createElement('span'); label.className = 'it-estimate-name'; label.textContent = tier.name;
        const track = document.createElement('span'); track.className = 'it-estimate-track'; track.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('span'); fill.className = 'it-estimate-fill'; track.append(fill);
        const value = document.createElement('span'); value.className = 'it-estimate-value';
        li.append(label, track, value); bars.append(li);
        return { tier, fill, value };
    });
    function update() {
        const users = read('users', 1, 200), computers = read('computers', 0, 200), locations = read('locations', 0, 20);
        const totals = rows.map(row => row.tier.rate * users + computers * extraComputer + locations * extraLocation);
        const top = Math.max(...totals);
        rows.forEach((row, index) => {
            row.fill.style.width = (top ? totals[index] / top * 100 : 0).toFixed(1) + '%';
            row.value.textContent = money(totals[index]) + ' a month';
        });
    }
    form.addEventListener('input', update);
    form.addEventListener('submit', event => event.preventDefault());
    update();
    form.hidden = false;
}());
