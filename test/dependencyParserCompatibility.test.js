const express = require('express');
const request = require('supertest');
const qs = require('qs');
const qsPackage = require('qs/package.json');

const POLLUTION_KEY = 'dep001Polluted';

function createParserHarness() {
    const app = express();

    app.set('query parser', 'extended');
    app.get('/query', (req, res) => {
        res.json(req.query);
    });

    app.post(
        '/form',
        express.urlencoded({
            extended: true,
            limit: '16kb',
            parameterLimit: 4
        }),
        (req, res) => {
            res.json(req.body);
        }
    );

    app.use((error, req, res, next) => {
        void next;
        res.status(error.status || 500).json({
            type: error.type || 'parser_error'
        });
    });

    return app;
}

describe('Express parser dependency compatibility', () => {
    afterEach(() => {
        delete Object.prototype[POLLUTION_KEY];
    });

    test('loads the patched qs release and enforces the array limit', () => {
        const parseExcessArray = () => qs.parse(
            'items[]=1,2,3,4',
            {
                arrayLimit: 3,
                comma: true,
                throwOnLimitExceeded: true
            }
        );

        expect(qsPackage.version).toBe('6.16.0');
        expect(parseExcessArray).toThrow(RangeError);
        expect(parseExcessArray).toThrow(/array limit exceeded/i);
    });

    test('preserves nested query and form parsing', async () => {
        const app = createParserHarness();

        const queryResponse = await request(app)
            .get('/query?filter%5Bregion%5D=north&tags%5B%5D=bus&tags%5B%5D=coach')
            .expect(200);

        expect(queryResponse.body).toEqual({
            filter: { region: 'north' },
            tags: ['bus', 'coach']
        });

        const formResponse = await request(app)
            .post('/form')
            .type('form')
            .send('profile%5Bname%5D=HQ&roles%5B%5D=viewer&roles%5B%5D=approver')
            .expect(200);

        expect(formResponse.body).toEqual({
            profile: { name: 'HQ' },
            roles: ['viewer', 'approver']
        });
    });

    test('rejects excess form parameters without mutating object prototypes', async () => {
        const app = createParserHarness();

        expect(Object.prototype.hasOwnProperty.call(Object.prototype, POLLUTION_KEY)).toBe(false);

        const pollutionResponse = await request(app)
            .get('/query?safe=yes&__proto__%5Bdep001Polluted%5D=true&constructor%5Bprototype%5D%5Bdep001Polluted%5D=true')
            .expect(200);

        expect(pollutionResponse.body.safe).toBe('yes');
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, POLLUTION_KEY)).toBe(false);

        const formPollutionResponse = await request(app)
            .post('/form')
            .type('form')
            .send('profile%5Bname%5D=HQ&__proto__%5Bdep001Polluted%5D=yes&constructor%5Bprototype%5D%5Bdep001Polluted%5D=yes')
            .expect(200);

        expect(formPollutionResponse.body.profile).toEqual({ name: 'HQ' });
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, POLLUTION_KEY)).toBe(false);

        const limitResponse = await request(app)
            .post('/form')
            .type('form')
            .send('a=1&b=2&c=3&d=4&e=5')
            .expect(413);

        expect(limitResponse.body.type).toBe('parameters.too.many');
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, POLLUTION_KEY)).toBe(false);
    });
});
