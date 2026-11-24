const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

describe('static build brand assets', () => {
    const root = path.resolve(__dirname, '..');
    const dist = path.join(root, 'dist');

    beforeAll(() => {
        execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root });
    });

    test('ships every self-hosted font that style.css references, with its licence', () => {
        const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
        const fonts = [...css.matchAll(/url\("(\/assets\/fonts\/[^"]+\.woff2)"\)/g)].map(match => match[1]);

        expect(fonts).toEqual(expect.arrayContaining([
            '/assets/fonts/fraunces-latin-opsz-normal.woff2',
            '/assets/fonts/fraunces-latin-opsz-italic.woff2',
            '/assets/fonts/inter-latin-wght-normal.woff2',
            '/assets/fonts/inter-latin-wght-italic.woff2'
        ]));
        for (const font of fonts) {
            expect(fs.existsSync(path.join(dist, font))).toBe(true);
        }
        for (const licence of ['Fraunces-OFL.txt', 'Inter-OFL.txt']) {
            expect(fs.readFileSync(path.join(dist, 'assets', 'fonts', licence), 'utf8')).toContain('SIL Open Font License');
        }
    });

    test('public pages, Operator, Support and MSSP use the same two self-hosted font families', () => {
        const read = file => fs.readFileSync(path.join(root, file), 'utf8');
        const token = (css, name) => (css.match(new RegExp(`--${name}:\\s*([^;]+);`)) || [])[1];
        const faces = css => [...css.matchAll(/url\("(\/assets\/fonts\/[^"]+\.woff2)"\)/g)].map(match => match[1]).sort();
        const base = read('style.css');
        for (const file of ['app/operator.css', 'app/support.css', 'app/mssp.css']) {
            const css = read(file);
            expect(faces(css)).toEqual(faces(base));
            for (const name of ['font-sans', 'font-display', 'font-serif']) expect(token(css, name)).toBe(token(base, name));
        }
        expect(token(base, 'font-serif')).toBe('var(--font-display)');
        expect(token(base, 'font-sans')).toMatch(/^"Inter"/);
        expect(token(base, 'font-display')).toMatch(/^"Fraunces"/);
    });

    test('ships the paper texture and hero mark the public pages reference', () => {
        for (const image of ['images/paper-texture.webp', 'images/nofries-mark-large.webp', 'images/nofrieslogo.png']) {
            expect(fs.existsSync(path.join(dist, image))).toBe(true);
        }
    });
});
