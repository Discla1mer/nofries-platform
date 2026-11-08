'use strict';
// Actual renderer/CSS; loopback-only synthetic transport. The submitted fixture
// was calculated by the real evaluator; interactive submissions are simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { launch } = require('./helpers/chromium-journey.cjs');
const { buildPreview } = require('../build-ncsc-questionnaire-preview');
async function run() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-persona-assessment-'));
    const preview = buildPreview(path.join(directory, 'questionnaire.html'));
    const unexpected = [], measurements = []; let browser;
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
        if (req.method !== 'GET' || pathname !== '/questionnaire-frame.html') { unexpected.push(req.method + ' ' + pathname); res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(fs.readFileSync(preview.frameOutput));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await launch(origin);
        await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
            window.personaWrites=[]; let factory;
            Object.defineProperty(window,'NoFriesNcscAssessmentClient',{configurable:true,get:()=>factory,set(value){
                factory=Object.freeze({...value,createClient(options){return value.createClient({...options,async fetch(url,init={}){
                    if(init.method==='POST') window.personaWrites.push({...JSON.parse(init.body),action:new URL(url,location.origin).pathname.split('/').pop()});
                    return options.fetch(url,init);
                }});}});
            }});` });
        for (const width of [1280, 320]) for (const scale of [1, 2]) {
            await browser.navigate(origin + '/questionnaire-frame.html?case=' + width + '-' + scale, width);
            await browser.wait('document.querySelector(".dashboard-module-link[data-module=cyber_security]")');
            await browser.evaluate(`[...document.querySelectorAll('.dashboard-module-link[data-module="cyber_security"]')].find(n=>n.getClientRects().length).id='persona-open'`);
            await browser.click('#persona-open'); await browser.wait('document.querySelector(".ncsc-assessment-list button")');
            const stages=[];
            async function scaleAndLayout(stage) {
                // Scale the existing font tokens only: layout lengths and viewport stay unchanged.
                // Tokens remain effective on asynchronously replaced question/review nodes.
                const measured=await browser.evaluate(`(()=>{const host=document.querySelector('.nofries-dashboard');
                    if(!window.personaFontBaseline){
                        const keys=['small','body','section','display'].map(k=>'--dashboard-font-'+k);
                        const original=keys.map(k=>getComputedStyle(host).getPropertyValue(k));
                        window.personaFontBaseline=parseFloat(getComputedStyle(document.querySelector('#ncsc-title')).fontSize);
                        keys.forEach((k,i)=>host.style.setProperty(k,'calc(('+original[i]+') * ${scale})'));
                        const banner=document.querySelector('.fixture-banner');banner.style.fontSize=(parseFloat(getComputedStyle(banner).fontSize)*${scale})+'px';
                    }
                    const title=document.querySelector('#ncsc-title'),controls=[...document.querySelectorAll('.ncsc-content button,.ncsc-content input,.ncsc-content textarea,.ncsc-content select')].filter(n=>n.getClientRects().length);
                    return {before:window.personaFontBaseline,after:parseFloat(getComputedStyle(title).fontSize),overflow:document.documentElement.scrollWidth-innerWidth,
                        outside:controls.filter(n=>{const r=n.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1;}).map(n=>n.id||n.textContent)};})()`);
                assert.equal(measured.after,measured.before*scale); assert.ok(measured.overflow<=1,JSON.stringify({width,scale,stage,...measured})); assert.deepEqual(measured.outside,[],JSON.stringify({width,scale,stage,...measured})); stages.push({stage,...measured});
            }
            async function button(text) {
                await browser.evaluate(`(()=>{const n=[...document.querySelectorAll('.ncsc-questionnaire button')].find(n=>n.textContent===${JSON.stringify(text)});if(!n)throw Error('Missing button');n.id='persona-action';})()`);
                await browser.click('#persona-action');
            }
            async function choose(option) { await browser.click('.ncsc-answer input[value="'+option+'"]'); }
            async function save(delayed) {
                if(delayed) await browser.evaluate(`document.getElementById('scenario').value='delay';document.getElementById('arm-scenario').click()`);
                await browser.evaluate(`document.getElementById('ncsc-save').focus();document.getElementById('ncsc-save').scrollIntoView({block:'center'})`);
                const before=await browser.evaluate(`({scroll:scrollY,question:document.getElementById('ncsc-question-index').value,writes:window.personaWrites.length})`);
                await browser.click('#ncsc-save',true);
                if(delayed) assert.equal(await browser.evaluate('document.getElementById("ncsc-save").disabled'),true);
                await browser.wait(`document.getElementById('ncsc-save')&&!document.getElementById('ncsc-save').disabled&&/Your progress is saved/.test(document.getElementById('ncsc-save-status').textContent)`);
                const after=await browser.evaluate(`({scroll:scrollY,question:document.getElementById('ncsc-question-index').value,focus:document.activeElement.id,writes:window.personaWrites.length})`);
                assert.ok(Math.abs(before.scroll-after.scroll)<=2,JSON.stringify({before,after})); assert.equal(after.question,before.question); assert.equal(after.focus,'ncsc-save'); assert.equal(after.writes,before.writes+1);
                return {delayed,before,after};
            }
            await scaleAndLayout('list');
            await browser.click('.ncsc-assessment-list button[data-assessment-id="assessment-b"]'); await browser.wait('document.getElementById("ncsc-question-index")');
            await scaleAndLayout('question'); await choose('partial'); const delayed=await save(true);
            await scaleAndLayout('saved'); await choose('no'); const immediate=await save(false);
            await button('Review and submit'); await browser.wait('document.querySelector(".ncsc-review")'); await scaleAndLayout('review');
            assert.equal(await browser.evaluate('document.querySelectorAll(".ncsc-review-item").length'),14);
            assert.match(await browser.evaluate('document.querySelector(".ncsc-review-scope").textContent'),/Synthetic population A/);
            const writes=await browser.evaluate('window.personaWrites.length'); await button('Back to questions'); assert.equal(await browser.evaluate('window.personaWrites.length'),writes);
            await button('Review and submit'); await button('Save and submit assessment'); await browser.wait('document.querySelector(".ncsc-next-steps")'); await scaleAndLayout('submitted-next-steps');
            assert.equal(await browser.evaluate('window.personaWrites.filter(c=>c.action==="submit").length'),1);
            assert.equal(await browser.evaluate('document.getElementById("ncsc-provider-summary").readOnly'),true);
            await button('Retry loading results'); await browser.wait('!document.querySelector(".ncsc-status").textContent.includes("Loading")');
            assert.equal(await browser.evaluate('window.personaWrites.filter(c=>c.action==="submit").length'),1);
            await button('Back to assessments'); await browser.wait('document.querySelector(".ncsc-assessment-list")');
            await button('Load more assessments');
            await browser.click('.ncsc-assessment-list button[data-assessment-id="assessment-submitted"]'); await browser.wait('document.querySelector(".ncsc-results")'); await scaleAndLayout('calculated-result-fixture');
            assert.ok(await browser.evaluate('document.querySelector(".ncsc-results").textContent.includes("%")'));
            assert.equal(await browser.evaluate('document.querySelector(".ncsc-content").querySelectorAll("input:not([disabled])").length'),0);
            measurements.push({width,scale,stages,delayed,immediate});
        }
        assert.deepEqual(browser.errors,[]); assert.deepEqual(browser.unexpected,[]); assert.deepEqual(unexpected,[]);
        return {browser:browser.version,synthetic:true,measurements};
    } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(directory,{recursive:true,force:true}); }
}
module.exports={run};
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
