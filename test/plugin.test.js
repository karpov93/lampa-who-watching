'use strict';

/**
 * Тесты плагина без зависимостей: node test/plugin.test.js
 *
 * Плагин грузится в отдельный vm-контекст с заглушкой Lampa. Проверяется
 * то, что легко сломать: условие показа, реверс порядка, пометка «наш вызов»,
 * «назад» -> родной выход и возврат гейта после отмены.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'who-watching.js'), 'utf8');
const GATE_DELAY = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeItems() {
    const profile = (id, name, extra) => Object.assign({
        id: id,
        name: name,
        icon: '<img src="https://cub.example/img/profiles/l_1.png" class="size-medium" />',
        template: 'selectbox_icon',
        title: name,
        selected: false
    }, extra || {});

    const add = {
        title: 'Добавить профиль',
        template: 'selectbox_icon',
        icon: '<svg class="size-medium"><use xlink:href="#sprite-plus"></use></svg>'
    };

    // Родной порядок: [«Добавить профиль»] + reverse(profiles)
    return [add, profile(2, 'Ольга'), profile(1, 'Андрей', { main: true })];
}

function createHarness(options) {
    const opts = Object.assign({
        version: 348,
        token: 'token',
        profiles: [1, 2],
        loadFails: false
    }, options || {});

    const state = {
        shown: [],
        selectCalls: 0,
        backCalls: 0,
        refreshCalls: 0,
        appListeners: []
    };

    const document = {
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById: () => null,
        createElement: () => ({
            style: {},
            appendChild() {},
            setAttribute() {},
            id: '',
            type: ''
        }),
        getElementsByTagName: () => [{ appendChild() {} }]
    };

    const Lampa = {
        Manifest: { app_digital: opts.version, app_version: '3.4.8-test' },
        Listener: {
            follow(name, fn) {
                if (name === 'app') state.appListeners.push(fn);
            },
            send() {}
        },
        Select: {
            show(object) {
                state.shown.push(object);
            },
            listener: { follow() {} }
        },
        Account: {
            Permit: { token: opts.token },
            Api: {
                load() {
                    if (opts.loadFails) return Promise.reject(new Error('network'));
                    return Promise.resolve({ secuses: true, profiles: opts.profiles.map((n) => ({ id: n })) });
                }
            },
            listener: { follow() {} },
            Profile: {
                select(callback) {
                    state.selectCalls++;
                    Lampa.Select.show({
                        title: 'Профили',
                        items: makeItems(),
                        onSelect() {},
                        onBack: callback,
                        onFullDraw() {}
                    });
                }
            }
        },
        Controller: {
            back() {
                state.backCalls++;
            }
        },
        Activity: {
            refresh() {
                state.refreshCalls++;
            }
        }
    };

    const sandbox = {
        window: null,
        document,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        Promise,
        Lampa
    };
    sandbox.window = sandbox;
    sandbox.jQuery = undefined;
    sandbox.$ = undefined;

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);
    return { sandbox, Lampa, state };
}

function boot(harness) {
    harness.state.appListeners.forEach((fn) => fn({ type: 'ready' }));
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

test('2 профиля: гейт открывается, экран fullsize, порядок естественный, «+» в конце', async () => {
    const h = createHarness({ profiles: [1, 2] });
    boot(h);
    await sleep(GATE_DELAY + 200);

    assert(h.state.selectCalls === 1, 'Profile.select должен вызваться один раз');
    assert(h.state.shown.length === 1, 'должен быть показан один селект');

    const object = h.state.shown[0];
    assert(object.fullsize === true, 'панель должна быть fullsize');
    assert(object.items.length === 3, 'два профиля плюс «Добавить профиль»');
    assert(object.items[0].title === 'Андрей', 'первым идёт основной профиль');
    assert(object.items[1].title === 'Ольга', 'вторым — остальные в естественном порядке');
    assert(object.items[2].title === 'Добавить профиль', '«Добавить профиль» — последним');
});

test('один профиль: гейт не показывается', async () => {
    const h = createHarness({ profiles: [1] });
    boot(h);
    await sleep(GATE_DELAY + 200);
    assert(h.state.selectCalls === 0, 'при одном профиле спрашивать нечего');
});

test('без аккаунта: гейт не показывается', async () => {
    const h = createHarness({ token: '' });
    boot(h);
    await sleep(GATE_DELAY + 200);
    assert(h.state.selectCalls === 0, 'без токена профилей нет');
});

test('старая Lampa: ничего не делаем', async () => {
    const h = createHarness({ version: 300 });
    boot(h);
    await sleep(GATE_DELAY + 200);
    assert(h.state.selectCalls === 0, 'на старом API плагин молчит');
});

test('ошибка profiles/all: гейт не показывается, Lampa работает', async () => {
    const h = createHarness({ loadFails: true });
    boot(h);
    await sleep(GATE_DELAY + 200);
    assert(h.state.selectCalls === 0, 'при ошибке сети гейта нет');
});

test('чужие селекты не трогаем', async () => {
    const h = createHarness({ profiles: [1, 2] });
    boot(h);
    await sleep(GATE_DELAY + 200);
    h.state.shown.length = 0;

    h.Lampa.Select.show({ title: 'Выбор качества', items: [{ title: '1080p' }] });
    assert(h.state.shown[0].fullsize === undefined, 'полноэкранность не навязана');
    assert(h.state.shown[0].items[0].title === '1080p', 'порядок не тронут');
});

test('«назад» на гейте: отдаём родному обработчику', async () => {
    const h = createHarness({ profiles: [1, 2] });
    boot(h);
    await sleep(GATE_DELAY + 200);

    h.state.shown[0].onBack();
    await sleep(50);
    assert(h.state.backCalls === 1, 'Controller.back должен быть вызван');
});

test('отмена родного окна «Выход» возвращает гейт', async () => {
    const h = createHarness({ profiles: [1, 2] });
    boot(h);
    await sleep(GATE_DELAY + 200);

    h.state.shown[0].onBack();
    await sleep(20);

    // Родное окно выхода: пункт «Да, выйти» и «Отмена»
    const exitPrompt = {
        title: 'Выход',
        items: [{ title: 'Да, выйти', out: true }, { title: 'Отмена' }],
        onSelect() {},
        onBack() {}
    };
    h.Lampa.Select.show(exitPrompt);
    exitPrompt.onSelect({ title: 'Отмена' });
    await sleep(200);

    assert(h.state.selectCalls === 2, 'после отмены выхода гейт открывается снова');
});

test('выход из приложения не возвращает гейт', async () => {
    const h = createHarness({ profiles: [1, 2] });
    boot(h);
    await sleep(GATE_DELAY + 200);

    h.state.shown[0].onBack();
    await sleep(20);

    const exitPrompt = {
        title: 'Выход',
        items: [{ title: 'Да, выйти', out: true }, { title: 'Отмена' }],
        onSelect() {},
        onBack() {}
    };
    h.Lampa.Select.show(exitPrompt);
    exitPrompt.onSelect({ title: 'Да, выйти', out: true });
    await sleep(200);

    assert(h.state.selectCalls === 1, 'после «Да, выйти» гейт не открывается');
});

(async () => {
    let failed = 0;
    for (const item of tests) {
        try {
            await item.fn();
            console.log('  ok  ' + item.name);
        } catch (e) {
            failed++;
            console.error('FAIL  ' + item.name + ' — ' + e.message);
        }
    }
    console.log('');
    console.log(failed ? failed + ' из ' + tests.length + ' тестов упали' : 'все ' + tests.length + ' тестов прошли');
    process.exit(failed ? 1 : 0);
})();
