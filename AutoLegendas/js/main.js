/* Auto Legendas - painel CEP (roda no Chromium do painel, com Node.js ligado) */
(function () {
    'use strict';

    var cs = new CSInterface();
    var $ = function (id) { return document.getElementById(id); };
    var qsa = function (sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); };

    var nodeOk = (typeof require === 'function');
    var fs, path, os, cp;
    if (nodeOk) {
        fs = require('fs');
        path = require('path');
        os = require('os');
        cp = require('child_process');
    }

    var STORE = 'autolegendas.v2';
    var OPEN_KEY = 'autolegendas.open';
    var FIELDS = ['model', 'lang', 'device', 'vad', 'python', 'mode', 'maxLines', 'maxWords', 'maxChars',
        'pause', 'punct', 'font', 'size', 'color', 'upper', 'stroke', 'strokeColor', 'strokeW',
        'shadow', 'shadowColor', 'shadowOp', 'shadowDist', 'shadowSoft', 'shadowAngle', 'box', 'boxColor',
        'boxOpacity', 'posY', 'anim', 'target', 'block', 'blockColor', 'blockChance', 'blockDist', 'blockMs'];
    var busy = false;
    var busyPrefix = '';
    var statusKind = '';
    var comp = { w: 1920, h: 1080, name: '' };

    // ---------- utilitarios ----------
    function getVal(id) {
        var el = $(id);
        return el.type === 'checkbox' ? el.checked : el.value;
    }
    function setVal(id, v) {
        var el = $(id);
        if (el.type === 'checkbox') { el.checked = !!v; } else { el.value = v; }
    }
    function num(id, fallback) {
        var v = parseFloat(String(getVal(id)).replace(',', '.'));
        return isNaN(v) ? fallback : v;
    }
    function clampInt(v, lo, hi) {
        return Math.max(lo, Math.min(hi, Math.round(v)));
    }
    function hexToRgb(hex) {   // 0..1, formato do After Effects
        var h = String(hex).replace('#', '');
        if (h.length !== 6) { return [1, 1, 1]; }
        return [
            parseInt(h.substr(0, 2), 16) / 255,
            parseInt(h.substr(2, 2), 16) / 255,
            parseInt(h.substr(4, 2), 16) / 255
        ];
    }
    function hexTo255(hex) {
        var c = hexToRgb(hex);
        return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
    }
    // literal JS seguro para mandar ao ExtendScript (escapa acentos como \uXXXX)
    function jsLiteral(v) {
        return JSON.stringify(v).replace(/[\u007f-￿]/g, function (c) {
            return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        });
    }
    function evalJSX(code) {
        return new Promise(function (resolve) {
            cs.evalScript(code, function (r) { resolve(String(r)); });
        });
    }

    // ---------- tema: usa as cores do proprio After Effects ----------
    function mix(a, b, t) {
        return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * t); });
    }
    function rgbCss(c) { return 'rgb(' + c.join(',') + ')'; }
    function applyTheme() {
        var env = null;
        try { env = cs.getHostEnvironment(); } catch (e) { env = null; }
        var c = env && env.appSkinInfo && env.appSkinInfo.panelBackgroundColor &&
            env.appSkinInfo.panelBackgroundColor.color;
        var bg = c ? [Math.round(c.red), Math.round(c.green), Math.round(c.blue)] : [35, 35, 35];
        var dark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 140;
        var fg = dark ? [224, 224, 224] : [34, 34, 34];
        var st = document.documentElement.style;
        st.setProperty('--bg', rgbCss(bg));
        st.setProperty('--fg', rgbCss(fg));
        st.setProperty('--card', rgbCss(mix(bg, fg, 0.06)));
        st.setProperty('--field', rgbCss(dark ? mix(bg, [0, 0, 0], 0.4) : mix(bg, [255, 255, 255], 0.75)));
        st.setProperty('--line', rgbCss(mix(bg, fg, 0.17)));
        st.setProperty('--thumb', rgbCss(mix(bg, fg, 0.28)));
        st.setProperty('--muted', rgbCss(mix(bg, fg, 0.58)));
    }

    // ---------- configuracoes salvas ----------
    function save() {
        try {
            var o = {};
            FIELDS.forEach(function (id) { o[id] = getVal(id); });
            localStorage.setItem(STORE, JSON.stringify(o));
        } catch (e) { /* sem storage, tudo bem */ }
    }
    function load() {
        var o = null;
        try { o = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { o = null; }
        if (!o) {
            // aproveita o estilo da versao anterior, mas usa os novos padroes de frases
            try {
                var old = JSON.parse(localStorage.getItem('autolegendas.v1') || 'null');
                if (old) {
                    o = {};
                    Object.keys(old).forEach(function (k) {
                        if (['pause', 'maxChars', 'maxWords'].indexOf(k) === -1) { o[k] = old[k]; }
                    });
                }
            } catch (e2) { o = null; }
        }
        if (!o) { return; }
        FIELDS.forEach(function (id) { if (o[id] !== undefined && $(id)) { setVal(id, o[id]); } });
    }

    // ---------- status / log ----------
    function setStatus(msg, kind) {
        var el = $('status');
        el.textContent = msg;
        statusKind = kind || '';
        el.className = 'status' + (kind ? ' ' + kind : '');
    }
    var logText = '';
    function resetLog() {
        logText = '';
        $('log').textContent = 'Nada por aqui ainda.';
    }
    function lastLine(text) {
        var lines = String(text).split(/[\r\n]+/).filter(function (l) { return l.trim(); });
        return lines.length ? lines[lines.length - 1].trim() : '';
    }
    function lastLines(text) {
        var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
        return lines.slice(-6).join('\n');
    }
    function appendLog(text) {
        logText = (logText + text).slice(-4000);
        var el = $('log');
        el.textContent = logText;
        el.scrollTop = el.scrollHeight;
        if (busy && statusKind === 'work') {   // mostra a linha mais recente enquanto trabalha
            var last = lastLine(logText);
            if (last) {
                var same = last.toLowerCase().indexOf(busyPrefix.toLowerCase()) === 0;
                setStatus(same ? last.slice(0, 110) : busyPrefix + ' - ' + last.slice(0, 110), 'work');
            }
        }
    }
    function setBusy(b, label) {
        busy = b;
        busyPrefix = label || '';
        $('btnGenerate').disabled = b;
        $('btnInstall').disabled = b;
        $('btnLabel').textContent = b ? label + '...' : 'Gerar legendas';
        document.body.classList.toggle('busy', b);
    }

    // ---------- caminhos ----------
    function extPath() {
        var p = '';
        try { p = cs.getSystemPath(SystemPath.EXTENSION); } catch (e) { p = ''; }
        if (!p || !fs.existsSync(path.join(p, 'python'))) {
            if (typeof __dirname !== 'undefined') { p = __dirname; }
        }
        return p;
    }

    // ---------- Python ----------
    function pythonParts() {
        var raw = String(getVal('python')).trim() || 'python';
        if (fs.existsSync(raw)) { return [raw]; }
        return raw.split(/\s+/);
    }
    function runPython(extraArgs, onText) {
        return new Promise(function (resolve, reject) {
            var parts = pythonParts();
            var child;
            try {
                child = cp.spawn(parts[0], parts.slice(1).concat(extraArgs), {
                    windowsHide: true,
                    env: Object.assign({}, process.env, {
                        PYTHONIOENCODING: 'utf-8',
                        PYTHONUNBUFFERED: '1'
                    })
                });
            } catch (e) { reject(e); return; }
            var out = '';
            function feed(d) {
                var t = d.toString('utf8');
                out += t;
                if (onText) { onText(t); }
            }
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', function (e) { reject(e); });
            child.on('close', function (code) { resolve({ code: code, out: out }); });
        });
    }
    function friendly(e) {
        if (e && e.code === 'ENOENT') {
            return 'Python não encontrado. Instale o Python (python.org, marcando "Add to PATH") ou informe o caminho no campo Python.';
        }
        return (e && e.message) ? e.message : String(e);
    }

    // ---------- fontes instaladas ----------
    var fontMap = {};      // nome PostScript / nome completo (minusculo) -> nome PostScript
    var fontNormMap = {};  // mesma coisa sem espacos, hifens e acentos
    var fontItems = [];    // { ps, label, key }
    var fontByPs = {};
    var fontCount = 0;
    var MAX_SHOW = 250;
    var faceCount = 0;
    var faceStyle = null;
    var fontEl = null, menuEl = null, firstShown = null, onEl = null;

    function norm(s) {
        return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function loadFonts() {
        $('fontHint').textContent = 'Carregando fontes...';
        return evalJSX('AL_listFonts()').then(function (r) {
            fontMap = {}; fontNormMap = {}; fontByPs = {}; fontItems = []; fontCount = 0;
            if (r.indexOf('OK|') !== 0) {
                $('fontHint').textContent = 'Não consegui listar as fontes. Digite o nome PostScript (ex.: Arial-BoldMT).';
                updatePreview();
                return;
            }
            var seen = {};
            r.slice(3).split('\n').forEach(function (line) {
                var p = line.split('\t');
                var ps = (p[0] || '').trim();
                if (!ps || seen[ps]) { return; }
                seen[ps] = true;
                var label = (p[1] || ps).trim();
                fontItems.push({ ps: ps, label: label, key: norm(label) + ' ' + norm(ps) });
            });
            fontItems.sort(function (a, b) { return a.label.localeCompare(b.label); });
            fontItems.forEach(function (it) {
                fontMap[it.ps.toLowerCase()] = it.ps;
                fontMap[it.label.toLowerCase()] = it.ps;
                fontNormMap[norm(it.ps)] = it.ps;
                fontNormMap[norm(it.label)] = it.ps;
                fontByPs[it.ps] = it;
            });
            fontCount = fontItems.length;
            $('fontHint').textContent = fontCount + ' fontes instaladas. Clique no campo ou na seta para ver a lista.';
            if (menuEl && !menuEl.hidden) { renderMenu(fontEl.value); }
            showFieldFont();
            updatePreview();
        });
    }

    // devolve o nome PostScript, ou null se a fonte nao existe na lista
    function resolveFont(typed) {
        var t = String(typed).trim();
        if (!fontCount) { return t || 'Arial-BoldMT'; }
        return fontMap[t.toLowerCase()] || fontNormMap[norm(t)] || null;
    }

    // cria (uma vez por fonte) um @font-face apontando para a fonte instalada no PC,
    // para o nome poder ser desenhado com ela mesma
    function faceFor(it) {
        if (it.face) { return it.face; }
        if (!faceStyle) {
            faceStyle = document.createElement('style');
            document.head.appendChild(faceStyle);
        }
        var clean = function (s) { return String(s).replace(/["\\\n\r]/g, ''); };
        it.face = 'ALF' + (faceCount++);
        faceStyle.appendChild(document.createTextNode(
            '@font-face{font-family:"' + it.face + '";src:local("' + clean(it.label) + '"),local("' + clean(it.ps) + '");}'));
        return it.face;
    }
    function familyCss(it) { return '"' + faceFor(it) + '", sans-serif'; }

    // o proprio campo Fonte tambem aparece na fonte escolhida
    function showFieldFont() {
        if (!fontEl) { return; }
        var ps = fontCount ? resolveFont(fontEl.value) : null;
        fontEl.style.fontFamily = (ps && fontByPs[ps]) ? familyCss(fontByPs[ps]) : '';
    }

    function renderMenu(query) {
        var tokens = String(query || '').toLowerCase().split(/\s+/).map(norm).filter(Boolean);
        var cur = fontCount ? resolveFont(getVal('font')) : null;
        var shown = 0, total = 0;
        firstShown = null;
        onEl = null;
        menuEl.innerHTML = '';
        fontItems.forEach(function (it) {
            for (var i = 0; i < tokens.length; i++) {
                if (it.key.indexOf(tokens[i]) === -1) { return; }
            }
            total++;
            if (shown >= MAX_SHOW) { return; }
            shown++;
            var d = document.createElement('div');
            d.className = 'item' + (it.ps === cur ? ' on' : '');
            d.textContent = it.label;
            d.title = it.ps;
            d.style.fontFamily = familyCss(it);
            d.addEventListener('mousedown', function (ev) {
                if (ev && ev.preventDefault) { ev.preventDefault(); }
                chooseFont(it);
            });
            menuEl.appendChild(d);
            if (!firstShown) { firstShown = it; }
            if (it.ps === cur) { onEl = d; }
        });
        if (!tokens.length) { firstShown = null; }
        var note = null;
        if (!fontItems.length) {
            note = 'Lista de fontes indisponível. Digite o nome PostScript.';
        } else if (!total) {
            note = 'Nenhuma fonte encontrada para "' + String(query).trim() + '".';
        } else if (total > shown) {
            note = '+' + (total - shown) + ' fontes. Digite para filtrar.';
        }
        if (note) {
            var n = document.createElement('div');
            n.className = 'note';
            n.textContent = note;
            menuEl.appendChild(n);
        }
    }

    function openMenu(query) {
        renderMenu(query);
        menuEl.hidden = false;
        if (onEl && !String(query || '').trim()) { menuEl.scrollTop = Math.max(0, onEl.offsetTop - 60); }
        try { menuEl.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ok */ }
    }
    function closeMenu() { menuEl.hidden = true; }

    function chooseFont(it) {
        fontEl.value = it.label;
        showFieldFont();
        closeMenu();
        onChange();
    }

    function initFontPicker() {
        fontEl = $('font');
        menuEl = $('fontMenu');
        var picker = fontEl.parentNode;
        fontEl.addEventListener('focus', function () {
            openMenu('');
            try { fontEl.select(); } catch (e) { /* ok */ }
        });
        fontEl.addEventListener('click', function () { if (menuEl.hidden) { openMenu(''); } });
        fontEl.addEventListener('input', function () {
            showFieldFont();
            openMenu(fontEl.value);
        });
        fontEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' || ev.key === 'Tab') {
                closeMenu();
            } else if (ev.key === 'Enter' && !menuEl.hidden && firstShown) {
                ev.preventDefault();
                chooseFont(firstShown);
            }
        });
        $('btnFontList').addEventListener('click', function () {
            if (menuEl.hidden) { openMenu(''); } else { closeMenu(); }
        });
        document.addEventListener('mousedown', function (ev) {
            if (!picker.contains(ev.target)) { closeMenu(); }
        });
    }

    // ---------- pre-visualizacao ----------
    function stripPunct(t, mode) {
        if (mode === 1) { t = t.replace(/(?<!\d)[.,…]+|[.,…]+(?!\d)/g, ''); }
        else if (mode >= 2) { t = t.replace(/(?<!\d)[.,…!?;:¿¡]+|[.,…!?;:¿¡]+(?!\d)/g, ''); }
        return t.replace(/\s+/g, ' ').trim();
    }
    function sampleLines() {
        var chunks = getVal('mode') === 'chunks';
        var lines;
        if (chunks) { lines = ['changed, no more']; }
        else if (parseInt(getVal('maxLines'), 10) === 1) { lines = ['changed, no more asking,']; }
        else { lines = ['changed, no more', 'asking, no more argue,']; }
        var pm = parseInt(getVal('punct'), 10) || 0;
        lines = lines.map(function (l) { return stripPunct(l, pm); });
        if (getVal('upper')) { lines = lines.map(function (l) { return l.toUpperCase(); }); }
        return lines;
    }
    function updatePreview() {
        var stage = $('stage'), cap = $('cap'), txt = $('capText'), inner = $('capInner');
        if (!stage || !cap || !txt || !inner) { return; }
        stage.style.setProperty('--ar', String(comp.w / comp.h));
        var sw = stage.clientWidth || 240;
        var sc = sw / comp.w;
        var size = Math.max(4, num('size', 70) * sc);

        var ps = fontCount ? resolveFont(getVal('font')) : null;
        var known = !!(ps && fontByPs[ps]);
        cap.style.top = Math.min(100, Math.max(0, num('posY', 50))) + '%';
        cap.style.fontSize = size + 'px';
        cap.style.lineHeight = (size * 1.2) + 'px';
        cap.style.fontFamily = known ? familyCss(fontByPs[ps]) : '"Segoe UI", Arial, sans-serif';
        cap.style.fontWeight = known ? 'normal' : '700';

        inner.textContent = sampleLines().join('\n');
        inner.style.color = getVal('color');

        // contorno: anel de sombras. A espessura VISIVEL e metade da largura do tracado,
        // porque o tracado fica por baixo do preenchimento (igual ao After Effects).
        var ring = [];
        if (getVal('stroke')) {
            var rw = Math.max(0.5, size * num('strokeW', 20) / 100 / 2);
            var rc = getVal('strokeColor');
            for (var k = 0; k < 24; k++) {
                var ra = k * Math.PI / 12;
                ring.push((Math.cos(ra) * rw).toFixed(2) + 'px ' + (Math.sin(ra) * rw).toFixed(2) + 'px 0 ' + rc);
            }
        }
        inner.style.textShadow = ring.length ? ring.join(',') : 'none';

        // drop shadow: filtro sobre o texto ja contornado (o efeito do After Effects tambem age depois do contorno)
        if (getVal('shadow')) {
            var sd = size * num('shadowDist', 12) / 100;
            var sg = num('shadowAngle', 135) * Math.PI / 180;   // 0 = cima, 90 = direita, 180 = baixo
            var shx = Math.sin(sg) * sd, shy = -Math.cos(sg) * sd;
            var shb = size * num('shadowSoft', 0) / 100;
            var shc = hexTo255(getVal('shadowColor'));
            var sho = Math.min(100, Math.max(0, num('shadowOp', 100))) / 100;
            inner.style.filter = 'drop-shadow(' + shx.toFixed(2) + 'px ' + shy.toFixed(2) + 'px ' + shb.toFixed(2) +
                'px rgba(' + shc.join(',') + ',' + sho + '))';
        } else {
            inner.style.filter = 'none';
        }

        if (getVal('box')) {
            var b = hexTo255(getVal('boxColor'));
            var a = Math.min(100, Math.max(0, num('boxOpacity', 60))) / 100;
            txt.style.background = 'rgba(' + b.join(',') + ',' + a + ')';
            txt.style.padding = (size * 0.075) + 'px ' + (size * 0.45) + 'px';
            txt.style.borderRadius = (size * 0.34) + 'px';
        } else {
            txt.style.background = 'transparent';
            txt.style.padding = '0';
            txt.style.borderRadius = '0';
        }
        $('compLabel').textContent = comp.w + ' x ' + comp.h;
    }
    function refreshComp() {
        return evalJSX('AL_compInfo()').then(function (r) {
            if (r.indexOf('OK|') === 0) {
                var p = r.split('|');
                var w = parseInt(p[1], 10), h = parseInt(p[2], 10);
                if (w > 0 && h > 0) { comp.w = w; comp.h = h; comp.name = p.slice(3).join('|'); }
            }
            updatePreview();
        });
    }

    // ---------- controles ----------
    function paintRange(r) {
        var min = parseFloat(r.min), max = parseFloat(r.max), v = parseFloat(r.value);
        r.style.setProperty('--p', (((v - min) / (max - min)) * 100) + '%');
    }
    function paintSegs() {
        qsa('.seg').forEach(function (seg) {
            var cur = String($(seg.getAttribute('data-for')).value);
            [].forEach.call(seg.children, function (b) {
                b.classList.toggle('on', b.getAttribute('data-v') === cur);
            });
        });
    }
    function syncNumbers() {
        qsa('input[type=number][data-for]').forEach(function (n) {
            n.value = $(n.getAttribute('data-for')).value;
        });
    }
    function syncUi() {
        var chunks = getVal('mode') === 'chunks';
        document.body.setAttribute('data-mode', chunks ? 'chunks' : 'phrase');
        document.body.setAttribute('data-stroke', getVal('stroke') ? 'on' : 'off');
        document.body.setAttribute('data-shadow', getVal('shadow') ? 'on' : 'off');
        document.body.setAttribute('data-box', getVal('box') ? 'on' : 'off');
        document.body.setAttribute('data-block', getVal('block') ? 'on' : 'off');
        $('lblChars').textContent = chunks ? 'Caracteres por bloco' : 'Caracteres por linha';
        var lines = parseInt(getVal('maxLines'), 10) || 2;
        $('modeNote').textContent = chunks
            ? 'Poucas palavras por vez, sem nunca juntar palavras de frases diferentes. Juntou frases? Diminua "Pausa entre frases".'
            : 'Cada frase fica inteira numa legenda, em até ' + lines + (lines === 1 ? ' linha' : ' linhas') +
              ', sem misturar com a frase seguinte. Juntou frases? Diminua "Pausa entre frases".';
        qsa('input[type=range]').forEach(paintRange);
        paintSegs();
    }
    function onChange() {
        save();
        syncUi();
        updatePreview();
    }

    function initControls() {
        // caixa numerica ao lado de cada controle deslizante
        qsa('input[type=number][data-for]').forEach(function (n) {
            var r = $(n.getAttribute('data-for'));
            n.min = r.min; n.max = r.max; n.step = r.step;
            r.addEventListener('input', function () { n.value = r.value; });
            n.addEventListener('input', function () {
                var v = parseFloat(n.value);
                if (!isNaN(v)) { r.value = v; onChange(); }
            });
            n.addEventListener('change', function () {
                var v = parseFloat(n.value);
                if (isNaN(v)) { v = parseFloat(r.value); }
                v = Math.min(parseFloat(r.max), Math.max(parseFloat(r.min), v));
                r.value = v;
                n.value = r.value;
                onChange();
            });
        });
        // botoes segmentados
        qsa('.seg').forEach(function (seg) {
            seg.addEventListener('click', function (ev) {
                var b = ev.target;
                while (b && b !== seg && b.tagName !== 'BUTTON') { b = b.parentNode; }
                if (!b || b === seg) { return; }
                $(seg.getAttribute('data-for')).value = b.getAttribute('data-v');
                onChange();
            });
        });
        // todo o resto
        FIELDS.forEach(function (id) {
            var el = $(id);
            el.addEventListener('input', onChange);
            el.addEventListener('change', onChange);
        });
        // secoes recolhiveis lembram se estavam abertas
        var st = {};
        try { st = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch (e) { st = {}; }
        qsa('details.card[data-key]').forEach(function (d) {
            var k = d.getAttribute('data-key');
            if (st[k] !== undefined) { d.open = !!st[k]; }
            d.addEventListener('toggle', function () {
                st[k] = d.open;
                try { localStorage.setItem(OPEN_KEY, JSON.stringify(st)); } catch (e) { /* ok */ }
                setTimeout(updatePreview, 0);
            });
        });
    }

    // ---------- visual da referencia: texto branco, contorno preto grosso e drop shadow ----------
    function applyLook() {
        var v = { stroke: true, strokeColor: '#000000', strokeW: 20, shadow: true, shadowColor: '#000000',
            shadowOp: 100, shadowDist: 12, shadowSoft: 0, shadowAngle: 135, box: false, color: '#ffffff' };
        Object.keys(v).forEach(function (k) { setVal(k, v[k]); });
        syncNumbers();
        onChange();
    }
    // na primeira vez que a v2.0 abre, ja aplica o visual (so uma vez; depois vale o que voce escolher)
    function migrateLook() {
        try {
            if (!localStorage.getItem('autolegendas.look18')) {
                applyLook();
                localStorage.setItem('autolegendas.look18', '1');
            }
        } catch (e) { /* sem storage: ficam os padroes da tela */ }
    }

    // ---------- opcoes de estilo enviadas ao After Effects ----------
    function buildOpts() {
        return {
            font: resolveFont(getVal('font')) || 'Arial-BoldMT',
            size: num('size', 70),
            color: hexToRgb(getVal('color')),
            upper: getVal('upper'),
            stroke: getVal('stroke'),
            strokeColor: hexToRgb(getVal('strokeColor')),
            strokeW: num('strokeW', 20),
            shadow: getVal('shadow'),
            shadowColor: hexToRgb(getVal('shadowColor')),
            shadowOp: num('shadowOp', 100),
            shadowDist: num('shadowDist', 12),
            shadowSoft: num('shadowSoft', 0),
            shadowAngle: num('shadowAngle', 135),
            box: getVal('box'),
            boxColor: hexToRgb(getVal('boxColor')),
            boxOpacity: num('boxOpacity', 60),
            posY: num('posY', 50),
            anim: parseInt(getVal('anim'), 10) || 0,
            block: getVal('block'),
            blockColor: hexToRgb(getVal('blockColor')),
            blockChance: clampInt(num('blockChance', 60), 0, 100),
            blockDist: clampInt(parseInt(getVal('blockDist'), 10) || 0, 0, 3),
            blockMs: clampInt(num('blockMs', 120), 20, 1000)
        };
    }

    // ---------- gerar ----------
    function generate() {
        if (busy) { return; }
        if (!nodeOk) {
            setStatus('O Node.js está desativado neste painel. Reinstale a extensão com o manifest original.', 'err');
            return;
        }
        save();
        if (resolveFont(getVal('font')) === null) {
            setStatus('Escolha a fonte na lista: clique numa das opções que aparecem abaixo do campo Fonte (ex.: "' +
                String(getVal('font')).trim() + ' Bold").', 'err');
            openMenu(getVal('font'));
            return;
        }
        setBusy(true, 'Transcrevendo');
        resetLog();
        setStatus('Lendo a camada selecionada...', 'work');

        var tsv, mapA, mapB;
        evalJSX('AL_getSource()').then(function (r) {
            var info = r.split('|');
            if (info[0] !== 'OK') {
                throw new Error(info[1] || ('Falha ao ler a camada: ' + r));
            }
            mapA = parseFloat(info[4]);
            mapB = parseFloat(info[5]);
            if (isNaN(mapA) || !(mapB > 0)) {
                throw new Error('Não consegui ler o tempo da camada selecionada.');
            }
            var nCand = parseInt(info[6], 10) || 1;
            var label = info.slice(7).join('|');
            appendLog('Áudio usado: ' + label + (nCand > 1 ?
                '  (havia mais ' + (nCand - 1) + ' áudio(s) na seleção; usei o de maior duração)' : '') + '\n');
            tsv = path.join(os.tmpdir(), 'autolegendas_' + Date.now() + '.tsv');
            var script = path.join(extPath(), 'python', 'transcrever.py');
            if (!fs.existsSync(script)) {
                throw new Error('Não achei python/transcrever.py dentro da pasta da extensão.');
            }
            var args = ['-u', script,
                '--file', info[1],
                '--out', tsv,
                '--model', String(getVal('model')),
                '--lang', String(getVal('lang')),
                '--start', info[2],
                '--end', info[3],
                '--mode', getVal('mode') === 'chunks' ? 'chunks' : 'phrase',
                '--max-lines', String(clampInt(num('maxLines', 2), 1, 4)),
                '--max-words', String(clampInt(num('maxWords', 4), 1, 12)),
                '--max-chars', String(clampInt(num('maxChars', 24), 8, 60)),
                '--pause', String(Math.max(0.05, num('pause', 0.30))),
                '--punct', String(parseInt(getVal('punct'), 10) || 0),
                '--device', getVal('device') === 'auto' ? 'auto' : 'cpu',
                '--target', String(getVal('target') || '')];
            if (getVal('vad')) { args.push('--vad'); }
            setStatus('Transcrevendo... o After Effects continua livre para usar.', 'work');
            return runPython(args, appendLog);
        }).then(function (res) {
            if (res.code === 2) {
                throw new Error((lastLines(res.out) || 'Dependências faltando ou desatualizadas.') +
                    '\n\nO texto acima mostra o motivo. Se já clicou em "Instalar dependências", me envie esta mensagem.');
            }
            if (res.code !== 0 || !fs.existsSync(tsv)) {
                throw new Error(lastLines(res.out) || 'A transcrição falhou.');
            }
            setStatus('Criando as camadas...', 'work');
            return evalJSX('AL_create(' + jsLiteral(tsv) + ',' + jsLiteral(buildOpts()) + ',' + mapA.toFixed(6) + ',' + mapB.toFixed(6) + ')');
        }).then(function (r) {
            var p = r.split('|');
            if (p[0] !== 'OK') {
                throw new Error(p[1] || ('Falha ao criar as camadas: ' + r));
            }
            var n = parseInt(p[1], 10) || 0;
            var noShadow = parseInt(p[2], 10) || 0;
            var nBlocks = parseInt(p[3], 10) || 0;
            if (n === 0) {
                setStatus('Nenhuma legenda foi criada. A composição pode ser mais curta que a fala.', 'err');
            } else if (noShadow > 0) {
                setStatus(n + ' legendas criadas, mas a sombra não foi aplicada em ' + noShadow +
                    ' (o efeito Drop Shadow não respondeu). Aplique o efeito nelas manualmente.', 'err');
            } else {
                setStatus('✓ ' + n + (n === 1 ? ' legenda criada.' : ' legendas criadas.') +
                    (getVal('block') ? ' Bloco branco em ' + nBlocks + '.' : ''), 'ok');
            }
        }).catch(function (e) {
            setStatus(friendly(e), 'err');
        }).then(function () {
            setBusy(false);
        });
    }

    // ---------- instalar dependencias ----------
    function installDeps() {
        if (busy) { return; }
        if (!nodeOk) {
            setStatus('O Node.js está desativado neste painel.', 'err');
            return;
        }
        save();
        setBusy(true, 'Instalando');
        resetLog();
        setStatus('Instalando o faster-whisper... pode levar alguns minutos.', 'work');
        var check = [
            'import sys, av, faster_whisper',
            'try:',
            "    av.open('nao_existe.mp4', metadata_errors='ignore')",
            'except TypeError:',
            "    print('av %s nao e compativel, precisa ser da 14 a 18 (%s)' % (av.__version__, av.__file__))",
            '    sys.exit(5)',
            'except Exception:',
            '    pass',
            "print('Python %s, av %s, faster-whisper %s' % (sys.version.split()[0], av.__version__, getattr(faster_whisper, '__version__', '?')))"
        ].join('\n');
        var noTr = false;
        runPython(['-m', 'pip', 'install', '--upgrade', 'faster-whisper', 'av>=14,<19', 'argostranslate'], appendLog).then(function (res) {
            if (res.code === 0) { return res; }
            noTr = true;
            appendLog('\nNão consegui instalar o tradutor (argostranslate). Instalando só o essencial...\n');
            return runPython(['-m', 'pip', 'install', '--upgrade', 'faster-whisper', 'av>=14,<19'], appendLog);
        }).then(function (res) {
            if (res.code !== 0) {
                setStatus(lastLines(res.out) || 'A instalação falhou.', 'err');
                return null;
            }
            setStatus('Conferindo a instalação...', 'work');
            return runPython(['-c', check], null).then(function (chk) {
                if (chk.code === 0) {
                    setStatus('✓ Instalado e conferido: ' + lastLines(chk.out) + '. Já pode gerar legendas.' +
                        (noTr ? ' (A tradução não foi instalada: só o inglês funciona sem ela.)' : ''), noTr ? 'err' : 'ok');
                } else {
                    setStatus('A instalação terminou, mas não funciona:\n' + lastLines(chk.out), 'err');
                }
            });
        }).catch(function (e) {
            setStatus(friendly(e), 'err');
        }).then(function () {
            setBusy(false);
        });
    }

    // ---------- inicio ----------
    applyTheme();
    try { cs.addEventListener(ThemeColorChangedEvent, applyTheme); } catch (e) { /* sem tema dinamico */ }
    load();
    initControls();
    initFontPicker();
    migrateLook();
    syncNumbers();
    syncUi();
    $('btnGenerate').addEventListener('click', generate);
    $('btnInstall').addEventListener('click', installDeps);
    $('btnLook').addEventListener('click', applyLook);
    $('btnComp').addEventListener('click', refreshComp);
    window.addEventListener('resize', updatePreview);
    window.addEventListener('focus', refreshComp);
    updatePreview();
    loadFonts();
    refreshComp();
    if (!nodeOk) {
        setStatus('Node.js desativado: o painel não consegue rodar o Whisper.', 'err');
    }
})();
