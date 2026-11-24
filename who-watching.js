/**
 * «Кто смотрит?» — выбор профиля CUB при каждом запуске Lampa.
 *
 * Что делает:
 *   при старте Lampa открывает родной выбор профилей (`Lampa.Account.Profile.select`)
 *   и раскладывает его горизонтальным рядом, как на стартовой PlayStation. Всё
 *   остальное — родное: панель `Select.show`, стили, фокус, подписи, добавление
 *   профиля, PIN родительского контроля.
 *
 * Чего не делает:
 *   не трогает профили, открытые из шапки/настроек (они остаются вертикальным
 *   списком), не ходит в сеть, кроме проверки числа профилей, ничего не хранит.
 *
 * Установка: «Расширения» → «Добавить плагин» → URL файла. Нужен аккаунт CUB
 * с двумя и более профилями, иначе показывать нечего.
 *
 * Лицензия: MIT. Проверено на Lampa 3.4.8 (app_digital 348).
 */
(function () {
    'use strict';

    if (window.who_watching_ready) return;
    window.who_watching_ready = true;

    var APP_MIN = 348;              // Lampa 3.4.8; на более старых API другой — не лезем
    var STYLE_ID = 'who-watching-style';
    var MARK = 'who-watching';
    var PROFILE_ICON_RE = /\/img\/profiles\//;
    var PENDING_TIMEOUT = 10000;    // маркер «наш вызов» живёт не дольше
    var EXIT_TIMEOUT = 5000;        // сколько ждём родное окно «Выход»
    var ACTIVITY_FALLBACK = 3000;   // если событие старта активности не пришло
    var PROFILES_TIMEOUT = 3000;    // не ждём ответ CUB бесконечно

    /* CSS вставляется одной строкой; всё строго под маркером .who-watching,
       чтобы не задеть ни один другой селект Lampa. */
    var CSS = [
        /* заставка на время проверки профилей: главная не мелькает под панелью */
        '.who-watching-cover{position:fixed;top:0;left:0;right:0;bottom:0;' +
            'background:#1d1f20;z-index:54;opacity:1;transition:opacity .2s}',
        '.who-watching-cover--hide{opacity:0}',
        /* панель занимает весь экран (родной режим fullsize) */
        '.who-watching .selectbox__head{padding:1.5em 2em 0}',
        '.who-watching .selectbox__title{font-size:2em}',
        '.who-watching .selectbox__body{align-items:center}',
        /* ряд шире экрана: центрирование заменяем на прокрутку с начала */
        '.who-watching--overflow .scroll__body{justify-content:flex-start}',
        /* вертикальную прокрутку родного Scroll гасим — ряд горизонтальный */
        '.who-watching .scroll{width:100%;height:auto!important;max-height:none!important}',
        '.who-watching .scroll--horizontal .scroll__content{padding:1.5em 1.5em 2em}',
        '.who-watching .scroll__body{display:flex;align-items:stretch;justify-content:center;' +
            'height:auto!important;max-height:none!important;overflow-x:auto;overflow-y:hidden;' +
            'padding:.4em 0;transform:none!important;-webkit-transform:none!important;' +
            'scrollbar-width:none;-ms-overflow-style:none}',
        '.who-watching .scroll__body::-webkit-scrollbar{width:0;height:0}',
        /* плитка */
        '.who-watching .selectbox-item{flex:0 0 auto;width:11em;margin:0 .7em;padding:1.4em 1em 1.2em;' +
            'flex-direction:column;align-items:center;justify-content:flex-start;text-align:center;' +
            'border-radius:1em;transition:transform .15s ease;will-change:transform}',
        '.who-watching .selectbox-item.focus{background-color:#353535;transform:scale(1.05)}',
        '.who-watching .selectbox-item__icon{width:6em;height:6em;margin:0 auto .9em;flex:0 0 auto}',
        '.who-watching .selectbox-item__icon>*{width:100%!important;height:100%!important}',
        '.who-watching .selectbox-item>div:last-child{width:100%}',
        '.who-watching .selectbox-item__title{font-size:1.2em;line-height:1.2;white-space:normal;' +
            'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
        '.who-watching .selectbox-item__subtitle{font-size:.95em;margin-top:.45em;min-height:1.3em}',
        /* родная галочка выбранного — в угол плитки */
        '.who-watching .selectbox-item.selected:not(.nomark){padding-right:1em}',
        '.who-watching .selectbox-item.selected:not(.nomark)::after{top:.9em;right:.9em;' +
            'width:.45em;height:.9em;border-width:0 .15em .15em 0}',
        /* пояснение приходит из родного onFullDraw — ставим под ряд */
        '.who-watching .selectbox__content>.selectbox__text{flex:0 0 auto;padding:0 2em 1.6em;' +
            'text-align:center;font-size:.95em;opacity:.6}',
        '.who-watching .selectbox__content>.selectbox__text>div{font-size:1em}'
    ].join('\n');

    /* Состояние гейта:
       pending — «следующий Select.show наш»;
       active  — наш селект сейчас открыт (для подмены контроллера);
       exiting — ждём родное окно «Выход», его отмена возвращает гейт. */
    var gate = {
        pending: false,
        pendingTimer: 0,
        exiting: false,
        exitTimer: 0,
        active: false,
        opened: false,
        panel: null,
        focused: null,
        cover: null
    };

    function log() {
        try {
            var args = ['[who-watching]'];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function supported() {
        try {
            return !!(window.Lampa &&
                Lampa.Manifest && (Lampa.Manifest.app_digital || 0) >= APP_MIN &&
                Lampa.Select && typeof Lampa.Select.show === 'function' &&
                Lampa.Account && Lampa.Account.Profile && typeof Lampa.Account.Profile.select === 'function' &&
                Lampa.Account.Permit && Lampa.Account.Api && typeof Lampa.Account.Api.load === 'function' &&
                Lampa.Controller && Lampa.Activity);
        } catch (e) {
            return false;
        }
    }

    function injectStyle() {
        try {
            if (document.getElementById(STYLE_ID)) return;
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.type = 'text/css';
            style.appendChild(document.createTextNode(CSS));
            var head = document.head || document.getElementsByTagName('head')[0] || document.body;
            if (head) head.appendChild(style);
        } catch (e) {
            log('style', e);
        }
    }

    /* Заставка: от включения до первого кадра выбора профиля за app не видно
       главной. Если профилей меньше двух — заставка уходит, Lampa как обычно. */
    function showCover() {
        try {
            if (gate.cover || !document.body) return;
            var el = document.createElement('div');
            el.className = 'who-watching-cover';
            document.body.appendChild(el);
            gate.cover = el;
        } catch (e) {
            log('cover', e);
        }
    }

    function hideCover() {
        var el = gate.cover;
        gate.cover = null;
        if (!el) return;
        try {
            el.className = el.className + ' who-watching-cover--hide';
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 250);
        } catch (e) {}
    }

    function isProfiles(items) {
        for (var i = 0; i < items.length; i++) {
            if (items[i] && typeof items[i].icon === 'string' && PROFILE_ICON_RE.test(items[i].icon)) return true;
        }
        return false;
    }

    function isExitPrompt(items) {
        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].out === true) return true;
        }
        return false;
    }

    /* Если у профиля в CUB нет картинки (или файл не открылся), родной список
       Lampa показывает «битую» картинку. В нашем ряду подставляем родную
       заглушку Lampa — ту же, что она ставит иконке профиля в шапке. */
    function withIconFallback(item) {
        if (item && typeof item.icon === 'string' && PROFILE_ICON_RE.test(item.icon)) {
            item.icon = item.icon.replace('<img ',
                '<img onerror="this.onerror=null;this.src=\'./img/img_load.svg\'" ');
        }
        return item;
    }

    /* Наш вызов профилей: экран на весь экран, профили в естественном порядке,
       «Добавить профиль» — последней плиткой. */
    function prepareGate(object) {
        gate.active = true;
        log('gate open');
        object.fullsize = true;
        object.items = object.items.slice().reverse().map(withIconFallback);

        var draw = object.onFullDraw;
        object.onFullDraw = function (scroll) {
            try {
                if (draw) draw.apply(this, arguments);
            } catch (e) {
                log('onFullDraw', e);
            }
            try {
                decorate(scroll);
            } catch (e) {
                log('decorate', e);
            }
        };

        var back = object.onBack;
        object.onBack = function () {
            try {
                if (back) back.apply(this, arguments);
            } catch (e) {
                log('onBack', e);
            }
            gate.active = false;
            requestExit();
        };
    }

    function decorate(scroll) {
        var $el = window.jQuery || window.$;
        if (!$el || !scroll) return;
        var panel = $el(scroll.render()).closest('.selectbox');
        if (!panel.length) return;

        panel.addClass(MARK);
        panel.find('.scroll').addClass('scroll--horizontal');

        // родное пояснение из onFullDraw уходит из ряда под него
        var text = panel.find('.selectbox__text');
        if (text.length) text.appendTo(panel.find('.selectbox__content'));

        gate.panel = panel;
        panel.on('hover:focus', '.selectbox-item', function () {
            gate.focused = this;
            follow(panel, this);
        });
        updateMask(panel);

        // панель выезжает 0.2 с: заставку убираем, когда она уже на месте
        setTimeout(hideCover, 260);

        setTimeout(function () {
            follow(panel, panel.find('.selectbox-item.focus')[0] || panel.find('.selectbox-item')[0]);
        }, 60);
    }

    /* Горизонтальная прокрутка под фокусом (родной Scroll умеет только вертикаль). */
    function follow(panel, item) {
        if (!item) return;
        var body = panel.find('.scroll__body')[0];
        if (!body) return;
        var br = body.getBoundingClientRect();
        var ir = item.getBoundingClientRect();
        var pad = 24;
        var left = ir.left - br.left + body.scrollLeft;
        var right = left + ir.width;
        if (left - pad < body.scrollLeft) body.scrollLeft = Math.max(0, left - pad);
        else if (right + pad > body.scrollLeft + body.clientWidth) body.scrollLeft = right + pad - body.clientWidth;
    }

    /* Маски по краям и режим прокрутки — только когда ряд реально не влезает. */
    function updateMask(panel) {
        var body = panel.find('.scroll__body')[0];
        if (!body) return;
        var overflow = body.scrollWidth > body.clientWidth + 4;
        panel.toggleClass('who-watching--overflow', overflow);
        panel.find('.scroll').toggleClass('scroll--mask', overflow);
    }

    /* Родной контроллер селекта умеет «вверх/вниз», а «влево» закрывает панель:
       для горизонтального ряда это неверно. Подменяем навигацию на нашей панели:
       влево/вправо — соседняя плитка, вверх/вниз — ничего (ряд один). */
    /* Lampa показывает своё окно «Выход» только через 2 секунды после запуска
       (иначе «назад» просто ничего не делает). Пока окна нет — не закрываем
       гейт: иначе нажатие «назад» тихо оставляло бы нас в приложении. */
    function exitReady() {
        var launched = window.app_time_launch || 0;
        return !launched || Date.now() > launched + 2100;
    }

    function tune(controller) {
        var nativeBack = controller.back;
        controller.left = function () { focusStep(-1); };
        controller.right = function () { focusStep(1); };
        controller.up = function () {};
        controller.down = function () {};
        controller.back = function () {
            if (!exitReady()) return;
            if (nativeBack) nativeBack.apply(this, arguments);
        };
    }

    function focusStep(step) {
        try {
            var panel = gate.panel;
            if (!panel || typeof panel.find !== 'function') return;
            var items = panel.find('.selectbox-item.selector');
            if (!items.length) return;
            var current = gate.focused ? items.index(gate.focused) : -1;
            if (current < 0) current = items.index(items.filter('.focus'));
            if (current < 0) current = 0;
            var next = Math.min(items.length - 1, Math.max(0, current + step));
            if (next === current) return;
            Lampa.Controller.collectionFocus(items.eq(next), panel);
        } catch (e) {
            log('focus', e);
        }
    }

    function patchController() {
        try {
            if (!Lampa.Controller || typeof Lampa.Controller.add !== 'function') return;
            if (Lampa.Controller.add.__who_watching) return;
            var add = Lampa.Controller.add;
            var wrapped = function (name, controller) {
                try {
                    if (name === 'select' && gate.active && controller) tune(controller);
                } catch (e) {
                    log('controller', e);
                }
                return add.apply(this, arguments);
            };
            wrapped.__who_watching = true;
            Lampa.Controller.add = wrapped;
        } catch (e) {
            log('patch controller', e);
        }
    }

    function openGate() {
        if (!supported()) return;
        gate.pending = true;
        clearTimeout(gate.pendingTimer);
        gate.pendingTimer = setTimeout(function () {
            gate.pending = false;
        }, PENDING_TIMEOUT);
        try {
            Lampa.Account.Profile.select(function () {
                gate.pending = false;
            });
        } catch (e) {
            gate.pending = false;
            hideCover();
            log('select', e);
        }
    }

    /* «Назад» на гейте — отдаём нажатие родному обработчику Lampa: на ТВ он
       показывает родное окно «Выход». На браузере окна нет — как без плагина. */
    function requestExit() {
        gate.exiting = true;
        clearTimeout(gate.exitTimer);
        gate.exitTimer = setTimeout(function () {
            gate.exiting = false;
        }, EXIT_TIMEOUT);
        setTimeout(function () {
            try {
                Lampa.Controller.back();
            } catch (e) {
                log('back', e);
            }
        }, 0);
    }

    /* Отмена в окне выхода возвращает к выбору профиля: остаться под прошлым
       профилем нельзя, иначе «спрашивать каждый запуск» обходится нажатием. */
    function wrapExit(object) {
        gate.exiting = false;
        clearTimeout(gate.exitTimer);

        var select = object.onSelect;
        var back = object.onBack;
        var done = false;

        function reopen() {
            if (done) return;
            done = true;
            setTimeout(openGate, 80);
        }

        object.onSelect = function (item) {
            var result = select && select.apply(this, arguments);
            if (!item || !item.out) reopen();
            return result;
        };

        object.onBack = function () {
            var result = back && back.apply(this, arguments);
            reopen();
            return result;
        };
    }

    /* Селектбокс в Lampa один на всё приложение: если наши классы остались
       на нём после закрытия гейта, они перекрашивают и окно «Выход», и
       профили из шапки. Поэтому перед каждым новым селектом снимаем маркеры;
       для своего вызова decorate поставит их снова. */
    function stripMarkers() {
        try {
            var $el = window.jQuery || window.$;
            if (!$el) return;
            $el('.selectbox.' + MARK).removeClass(MARK + ' who-watching--overflow');
            $el('.selectbox .scroll.scroll--horizontal').removeClass('scroll--horizontal');
        } catch (e) {
            log('strip', e);
        }
    }

    function inspect(object) {
        stripMarkers();
        if (!object || !object.items || !object.items.length) return;
        if (gate.exiting && isExitPrompt(object.items)) {
            wrapExit(object);
            return;
        }
        if (gate.pending && isProfiles(object.items)) {
            gate.pending = false;
            clearTimeout(gate.pendingTimer);
            prepareGate(object);
        }
    }

    function wrapSelect() {
        if (!Lampa.Select || typeof Lampa.Select.show !== 'function') return;
        if (Lampa.Select.show.__who_watching) return;

        var original = Lampa.Select.show;
        var wrapped = function (object) {
            try {
                inspect(object);
            } catch (e) {
                gate.pending = false;
                log('inspect', e);
            }
            return original.apply(this, arguments);
        };
        wrapped.__who_watching = true;
        Lampa.Select.show = wrapped;
    }

    function subscribe() {
        try {
            Lampa.Account.listener.follow('profile_select', function () {
                setTimeout(function () {
                    try {
                        Lampa.Activity.refresh();
                    } catch (e) {
                        log('refresh', e);
                    }
                }, 250);
            });
        } catch (e) {
            log('subscribe profile_select', e);
        }

        try {
            Lampa.Listener.follow('resize_end', function () {
                if (gate.panel) updateMask(gate.panel);
            });
        } catch (e) {}

        try {
            Lampa.Select.listener.follow('hide', function () {
                if (gate.active) log('select hidden');
                gate.active = false;
                gate.panel = null;
                gate.focused = null;
                hideCover();
            });
            Lampa.Select.listener.follow('close', function () {
                if (gate.active) log('select closed');
                gate.active = false;
                gate.panel = null;
                gate.focused = null;
                hideCover();
            });
        } catch (e) {
            log('subscribe select', e);
        }
    }

    /* Гейт открываем после старта первой активности: иначе старт главной
       перехватывает контроллер и кнопки пульта «не работают». */
    function whenStarted(callback) {
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            callback();
        }
        try {
            if (Lampa.Activity.all && Lampa.Activity.all().length) {
                setTimeout(finish, 60);
                return;
            }
            Lampa.Listener.follow('activity', function (e) {
                if (e && e.type === 'start') setTimeout(finish, 60);
            });
        } catch (e) {}
        setTimeout(finish, ACTIVITY_FALLBACK);
    }

    function profileCount(callback) {
        var done = false;
        function finish(list) {
            if (done) return;
            done = true;
            callback(list || []);
        }
        setTimeout(function () { finish([]); }, PROFILES_TIMEOUT);
        try {
            var request = Lampa.Account.Api.load('profiles/all');
            if (!request || typeof request.then !== 'function') return finish([]);
            request.then(function (result) {
                finish((result && result.profiles) || []);
            })['catch'](function (e) {
                log('profiles/all', e && e.message ? e.message : e);
                finish([]);
            });
        } catch (e) {
            finish([]);
        }
    }

    function maybeGate() {
        if (gate.opened || !supported()) return;

        try {
            if (window.lampa_settings && window.lampa_settings.account_use === false) return;
            if (!Lampa.Account.Permit.token) return; // без аккаунта профилей нет
        } catch (e) {
            return;
        }

        showCover();
        profileCount(function (list) {
            log('profiles', list.length);
            if (gate.opened) return;
            if (list.length < 2) { // один профиль — спрашивать нечего
                hideCover();
                return;
            }
            whenStarted(function () {
                log('activity started, opening gate');
                if (gate.opened) {
                    hideCover();
                    return;
                }
                gate.opened = true;
                openGate();
            });
        });
    }

    function init() {
        injectStyle();
        try {
            patchController();
            wrapSelect();
        } catch (e) {
            log('wrap', e);
        }
        subscribe();
        log('init', Lampa.Manifest ? Lampa.Manifest.app_version : '?');
        setTimeout(maybeGate, 0);
    }

    /* Заставку ставим сразу при загрузке плагина, ещё до Render.app: главная
       успевает отрисоваться раньше события ready, и на телевизоре её видно
       через полупрозрачный экран загрузки. */
    try {
        injectStyle(); // заставке нужен CSS до события ready
        if (window.Lampa && Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.token) showCover();
    } catch (e) {}

    try {
        if (window.appready) init();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') init();
            });
        }
    } catch (e) {
        log('boot', e);
    }
})();
