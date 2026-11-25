'use strict';

const { charts } = require('../api/shared/protectedAssets/organisationPicture');
const { createDom } = require('./fixtures/dashboardDom');

const find = (spec, predicate) => predicate(spec) ? spec : (spec.children || []).filter(child => typeof child === 'object').map(child => find(child, predicate)).find(Boolean);

describe('Overview chart kit', () => {
    test('the gauge draws the reported figure solid and the "up to" band hatched, with a plain label', () => {
        const spec = charts.gaugeSpec(28.6, 42.9, '28.6 percent in place, up to 42.9 percent');
        expect(spec.attrs).toMatchObject({ role: 'img', 'aria-label': '28.6 percent in place, up to 42.9 percent' });
        expect(find(spec, node => node.attrs['data-band'] === 'lower').attrs['stroke-dasharray']).toBe('28.6 100');
        const upper = find(spec, node => node.attrs['data-band'] === 'upper').attrs;
        expect(Number(upper['stroke-dasharray'].split(' ')[0])).toBeCloseTo(14.3, 5);
        expect(upper['stroke-dashoffset']).toBe('-28.6');
        expect(JSON.stringify(spec)).not.toMatch(/style/);
    });

    test('the gauge clamps bad input and never shows an upper figure below the lower one', () => {
        const spec = charts.gaugeSpec(150, 10, 'x');
        expect(find(spec, node => node.attrs['data-band'] === 'lower').attrs['stroke-dasharray']).toBe('100 100');
        expect(find(spec, node => node.attrs['data-band'] === 'upper').attrs['stroke-dasharray']).toBe('0 100');
        expect(find(charts.gaugeSpec('n/a', null, 'x'), node => node.attrs['data-band'] === 'lower').attrs['stroke-dasharray']).toBe('0 100');
    });

    test('the hatch pattern id is stable so repeated renders compare equal', () => {
        expect(find(charts.gaugeSpec(1, 2, 'a'), node => node.tag === 'pattern').attrs.id).toBe('nf-chart-hatch');
    });

    test('the donut splits answers in order and leaves out empty segments', () => {
        const spec = charts.donutSpec([{ value: 3, tone: 'solid' }, { value: 0, tone: 'partial' }, { value: 1, tone: 'no' }], 4, 'Answers');
        const rings = spec.children.filter(child => child.attrs && child.attrs['data-tone']);
        expect(rings.map(ring => [ring.attrs['data-tone'], ring.attrs['stroke-dasharray'], ring.attrs['stroke-dashoffset']]))
            .toEqual([['solid', '75 100', '0'], ['no', '25 100', '-75']]);
        expect(charts.donutSpec([], 0, 'None').children.filter(child => child.attrs && child.attrs['data-tone'])).toHaveLength(0);
    });

    test('draw builds DOM nodes and marks charts as images that do not take focus', () => {
        const dom = createDom();
        const svg = charts.draw(dom.document, charts.donutSpec([{ value: 1, tone: 'solid' }], 1, 'One answer'));
        expect(svg.getAttribute('role')).toBe('img');
        expect(svg.getAttribute('focusable')).toBe('false');
        expect(svg.textContent).toContain('1');
    });

    test('percent displays parse only well-formed percentages', () => {
        expect(charts.percentNumber('28.6%')).toBe(28.6);
        expect(charts.percentNumber('100%')).toBe(100);
        expect(charts.percentNumber('about 20%')).toBeNull();
        expect(charts.percentNumber(null)).toBeNull();
    });
});
