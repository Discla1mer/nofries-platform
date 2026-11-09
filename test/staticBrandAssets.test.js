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
            '/assets/fonts/fraunces-latin-opsz-italic.woff2'
        ]));
        for (const font of fonts) {
            expect(fs.existsSync(path.join(dist, font))).toBe(true);
        }
        expect(fs.readFileSync(path.join(dist, 'assets', 'fonts', 'Fraunces-OFL.txt'), 'utf8')).toContain('SIL Open Font License');
    });

    test('ships the paper texture and hero mark the public pages reference', () => {
        for (const image of ['images/paper-texture.webp', 'images/nofries-mark-large.webp', 'images/nofrieslogo.png']) {
            expect(fs.existsSync(path.join(dist, image))).toBe(true);
        }
    });
});
