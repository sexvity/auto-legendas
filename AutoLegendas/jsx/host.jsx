/*
  host.jsx - roda DENTRO do After Effects (ExtendScript, ES3).
  Chamado pelo painel (js/main.js) via CSInterface.evalScript.
*/

// ---------- 1) acha a fala: camada de arquivo OU pre-comp (inclusive aninhada) ----------
// Mapeamento: tempo s do ARQUIVO  ->  tempo T da composicao ativa:  T = a + b * s
// [lo, hi] = trecho visivel, em tempo da composicao ativa.
function AL_collect(layer, a, b, lo, hi, depth, out, trail, state) {
    var src = null;
    try { src = layer.source; } catch (e0) { src = null; }
    if (!src) {
        return;
    }
    if (!(b > 0)) {
        return;
    }
    var hasAud = false;
    try { hasAud = layer.hasAudio; } catch (e1) { hasAud = false; }
    if (!hasAud) {
        return;
    }
    if (depth > 0) {
        // dentro de uma pre-comp, so conta o que esta com o audio ligado
        var aOn = false;
        try { aOn = layer.audioEnabled; } catch (e2) { aOn = false; }
        if (!aOn) {
            return;
        }
    }
    var remap = false;
    try { remap = layer.timeRemapEnabled; } catch (e3) { remap = false; }
    if (remap) {
        state.remap = true;
        return;
    }

    if (src instanceof CompItem) {
        if (depth >= 8) {
            return;
        }
        var sub = trail ? (trail + " > " + layer.name) : layer.name;
        var n = src.numLayers;
        var i, K, ka, kb, klo, khi, nlo, nhi;
        for (i = 1; i <= n; i++) {
            K = src.layer(i);
            try {
                ka = K.startTime;
                kb = K.stretch / 100;
                klo = Math.max(a, a + b * K.inPoint);
                khi = Math.min(a + b * src.duration, a + b * K.outPoint);
            } catch (e4) {
                continue;
            }
            nlo = Math.max(lo, klo);
            nhi = Math.min(hi, khi);
            if (nhi - nlo < 0.05) {
                continue;
            }
            AL_collect(K, a + b * ka, b * kb, nlo, nhi, depth + 1, out, sub, state);
        }
        return;
    }

    var ms = null;
    try { ms = src.mainSource; } catch (e5) { ms = null; }
    if (!(ms instanceof FileSource)) {
        return;
    }
    var f = null;
    try { f = src.file; } catch (e6) { f = null; }
    if (!f || !f.exists) {
        return;
    }
    out.push({
        file: f, a: a, b: b, lo: lo, hi: hi,
        label: src.name + (trail ? " (em " + trail + ")" : "")
    });
}

// Resposta: "OK|arquivo|inicio|fim|a|b|candidatos|nome"  (inicio/fim = trecho visivel, em tempo do ARQUIVO)
function AL_getSource() {
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            return "ERR|Abra uma composição primeiro.";
        }
        var sel = comp.selectedLayers;
        if (sel.length === 0) {
            return "ERR|Selecione na timeline a camada com a fala (vídeo, áudio ou pre-comp).";
        }
        var out = [];
        var state = { remap: false };
        var i, L;
        for (i = 0; i < sel.length; i++) {
            L = sel[i];
            try {
                AL_collect(L, L.startTime, L.stretch / 100, L.inPoint, L.outPoint, 0, out, "", state);
            } catch (eL) {
                // camada sem fonte (texto, luz, camera...): ignora
            }
        }
        if (out.length === 0) {
            if (state.remap) {
                return "ERR|A fala está numa camada com Time Remap ligado. Desative o Time Remap e tente de novo.";
            }
            return "ERR|Não achei áudio nessa seleção. Selecione a camada de vídeo/áudio com a fala ou uma pre-comp que tenha, dentro dela, uma camada com o som ligado.";
        }
        var best = out[0];
        for (i = 1; i < out.length; i++) {
            if ((out[i].hi - out[i].lo) > (best.hi - best.lo) + 0.001) {
                best = out[i];
            }
        }
        var fs0 = Math.max(0, (best.lo - best.a) / best.b);
        var fe0 = Math.max(0, (best.hi - best.a) / best.b);
        return "OK|" + best.file.fsName + "|" + fs0.toFixed(3) + "|" + fe0.toFixed(3) + "|" +
            best.a.toFixed(6) + "|" + best.b.toFixed(6) + "|" + out.length + "|" + best.label;
    } catch (e) {
        return "ERR|" + e.toString();
    }
}

// ---------- 1a) tamanho da composicao ativa ----------
function AL_compInfo() {
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            return "ERR|Nenhuma composição aberta.";
        }
        return "OK|" + comp.width + "|" + comp.height + "|" + comp.name;
    } catch (e) {
        return "ERR|" + e.toString();
    }
}

// ---------- 1b) lista as fontes instaladas no PC ----------
// Resposta: "OK|" + linhas "nomePostScript<TAB>nome completo" separadas por \n
function AL_listFonts() {
    try {
        if (typeof app.fonts === "undefined" || !app.fonts) {
            return "ERR|Esta versão do After Effects não lista as fontes.";
        }
        var all = app.fonts.allFonts;
        var out = [];
        var i, j, f;
        for (i = 0; i < all.length; i++) {
            for (j = 0; j < all[i].length; j++) {
                f = all[i][j];
                if (f && f.postScriptName) {
                    out.push(f.postScriptName + "\t" + (f.fullName || f.postScriptName));
                }
            }
        }
        return "OK|" + out.join("\n");
    } catch (e) {
        return "ERR|" + e.toString();
    }
}

// ---------- 2) animacao de entrada ----------
// modo: 0 nenhuma, 1 fade, 2 pop, 3 slide
function AL_easeAll(prop) {
    try {
        var dims = 1;
        var vt = prop.propertyValueType;
        if (vt === PropertyValueType.TwoD) {
            dims = 2;
        } else if (vt === PropertyValueType.ThreeD) {
            dims = 3;
        }
        var e = new KeyframeEase(0, 60);
        var arr = [];
        var d, k;
        for (d = 0; d < dims; d++) {
            arr.push(e);
        }
        for (k = 1; k <= prop.numKeys; k++) {
            prop.setTemporalEaseAtKey(k, arr, arr);
        }
    } catch (err) {
        // sem suavizacao, tudo bem
    }
}

function AL_animateIn(layer, mode, basePos) {
    if (mode === 0) {
        return;
    }
    var tr = layer.property("ADBE Transform Group");
    var op = tr.property("ADBE Opacity");
    var sc = tr.property("ADBE Scale");
    var ps = tr.property("ADBE Position");
    var t0 = layer.inPoint;
    var baseOp = op.value;

    if (mode === 1) {
        op.setValueAtTime(t0, 0);
        op.setValueAtTime(t0 + 0.12, baseOp);
    } else if (mode === 2) {
        var three = (sc.value.length === 3);
        var s = function (v) {
            return three ? [v, v, 100] : [v, v];
        };
        sc.setValueAtTime(t0, s(70));
        sc.setValueAtTime(t0 + 0.08, s(108));
        sc.setValueAtTime(t0 + 0.15, s(100));
        op.setValueAtTime(t0, 0);
        op.setValueAtTime(t0 + 0.06, baseOp);
    } else if (mode === 3) {
        ps.setValueAtTime(t0, [basePos[0], basePos[1] + 30]);
        ps.setValueAtTime(t0 + 0.15, basePos);
        op.setValueAtTime(t0, 0);
        op.setValueAtTime(t0 + 0.12, baseOp);
    }
    if (op.numKeys > 0) { AL_easeAll(op); }
    if (sc.numKeys > 0) { AL_easeAll(sc); }
    if (ps.numKeys > 0) { AL_easeAll(ps); }
}

// ---------- 3) drop shadow (efeito "Drop Shadow" do After Effects) ----------
// O efeito age sobre a camada ja desenhada (texto + contorno), entao a sombra acompanha o contorno.
function AL_fxProp(fx, matchName, dispName, idx) {
    var p = null;
    try { p = fx.property(matchName); } catch (e1) { p = null; }
    if (!p) {
        try { p = fx.property(dispName); } catch (e2) { p = null; }
    }
    if (!p) {
        try { p = fx.property(idx); } catch (e3) { p = null; }
    }
    return p;
}

function AL_addShadow(layer, o) {
    try {
        var fxg = layer.property("ADBE Effect Parade");
        var fx = fxg.addProperty("ADBE Drop Shadow");
        if (!fx) {
            return false;
        }
        var pCol = AL_fxProp(fx, "ADBE Drop Shadow-0001", "Shadow Color", 1);
        var pOp = AL_fxProp(fx, "ADBE Drop Shadow-0002", "Opacity", 2);
        var pDir = AL_fxProp(fx, "ADBE Drop Shadow-0003", "Direction", 3);
        var pDis = AL_fxProp(fx, "ADBE Drop Shadow-0004", "Distance", 4);
        var pSof = AL_fxProp(fx, "ADBE Drop Shadow-0005", "Softness", 5);
        if (!pCol || !pOp || !pDir || !pDis || !pSof) {
            return false;
        }
        pCol.setValue([o.shadowColor[0], o.shadowColor[1], o.shadowColor[2], 1]);
        var op = o.shadowOp;
        try {
            if (pOp.hasMax) {
                op = (o.shadowOp / 100) * pOp.maxValue;   // este efeito pode usar 0-255 por dentro
            }
        } catch (eMax) {
            op = o.shadowOp;
        }
        pOp.setValue(op);
        pDir.setValue(o.shadowAngle);
        pDis.setValue(o.size * o.shadowDist / 100);
        pSof.setValue(o.size * o.shadowSoft / 100);
        return true;
    } catch (e) {
        return false;
    }
}

// ---------- 4) cria uma legenda ----------
// a, b: tempo do arquivo -> tempo da composicao ativa (T = a + b * s)
// devolve 0 (pulada), 1 (criada) ou 2 (criada, mas a sombra nao foi aplicada)
function AL_createCaption(comp, cap, o, a, b) {
    var tStart = a + cap.s * b;
    var tEnd = Math.min(a + cap.e * b, comp.duration);
    if (tStart < 0) {
        tStart = 0;
    }
    if (tEnd <= tStart || tStart >= comp.duration) {
        return 0;
    }

    // quebras de linha chegam como a sequencia \n (barra + n)
    var parts = cap.t.split("\\n");
    var nLines = parts.length;
    var oneLine = parts.join(" ");
    var txt = parts.join("\r");
    if (o.upper) {
        txt = txt.toUpperCase();
    }
    var tl = comp.layers.addText(txt);
    tl.name = "Cap: " + oneLine;

    // estilo do texto
    var sp = tl.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = sp.value;
    doc.resetCharStyle();
    doc.fontSize = o.size;
    doc.font = o.font;
    doc.applyFill = true;
    doc.fillColor = o.color;
    doc.applyStroke = o.stroke;
    if (o.stroke) {
        doc.strokeColor = o.strokeColor;
        doc.strokeWidth = Math.max(1, o.size * o.strokeW / 100);
        doc.strokeOverFill = false;   // o preenchimento fica por cima do contorno
        try {
            // quina arredondada (o padrao do After Effects e pontiagudo e cria "espinhos" em x, v, k...)
            if (typeof LineJoinType !== "undefined") {
                doc.lineJoinType = LineJoinType.LINE_JOIN_ROUND;
            }
        } catch (eJoin) {
            // versoes sem esse recurso ficam com a quina padrao
        }
    }
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    try {
        doc.autoLeading = false;
        doc.leading = o.size * 1.2;   // espacamento fixo entre as linhas
    } catch (eLead) {
        // versoes sem esse recurso usam o espacamento automatico
    }
    sp.setValue(doc);

    // tempo
    tl.startTime = tStart;
    tl.inPoint = tStart;
    tl.outPoint = tEnd;

    // centralizacao: X pelo centro do texto, Y FIXO (virgula/g/p nao mexem na altura)
    var r = tl.sourceRectAtTime(tStart, false);
    var ax = r.left + r.width / 2;
    var ay = -o.size * 0.35 + (nLines - 1) * o.size * 0.6;   // centro do bloco de texto
    var px = comp.width / 2;
    var py = comp.height * o.posY / 100;
    var tr = tl.property("ADBE Transform Group");
    tr.property("ADBE Anchor Point").setValue([ax, ay]);
    tr.property("ADBE Position").setValue([px, py]);

    // caixa de fundo (altura fixa, largura acompanha o texto)
    var bl = null;
    if (o.box) {
        var boxH = o.size * 1.35 + (nLines - 1) * o.size * 1.2;
        var boxW = r.width + o.size * 0.9;
        bl = comp.layers.addShape();
        bl.name = "Box: " + oneLine;
        var grp = bl.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        var gc = grp.property("ADBE Vectors Group");
        var rc = gc.addProperty("ADBE Vector Shape - Rect");
        rc.property("ADBE Vector Rect Size").setValue([boxW, boxH]);
        rc.property("ADBE Vector Rect Roundness").setValue(boxH * 0.25);
        var fl = gc.addProperty("ADBE Vector Graphic - Fill");
        fl.property("ADBE Vector Fill Color").setValue(o.boxColor);
        var btr = bl.property("ADBE Transform Group");
        btr.property("ADBE Anchor Point").setValue([0, 0]);
        btr.property("ADBE Position").setValue([px, py]);
        btr.property("ADBE Opacity").setValue(o.boxOpacity);
        bl.startTime = tStart;
        bl.inPoint = tStart;
        bl.outPoint = tEnd;
        bl.moveAfter(tl); // caixa fica embaixo do texto
    }

    AL_animateIn(tl, o.anim, [px, py]);
    if (bl) {
        AL_animateIn(bl, o.anim, [px, py]);
    }

    var shadowFail = false;
    if (o.shadow) {
        if (!AL_addShadow(tl, o)) {
            shadowFail = true;
        }
    }
    return shadowFail ? 2 : 1;
}

// ---------- 5) le o TSV gerado pelo Python e cria todas as legendas ----------
// Resposta: "OK|legendas criadas|legendas sem sombra"
function AL_create(tsvPath, o, a, b) {
    var opened = false;
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            return "ERR|Abra uma composição primeiro.";
        }

        var f = new File(tsvPath);
        f.encoding = "UTF-8";
        if (!f.open("r")) {
            return "ERR|Não consegui abrir o arquivo de legendas.";
        }
        var txt = f.read();
        f.close();

        var lines = txt.split("\n");
        var caps = [];
        var n, p, line;
        for (n = 0; n < lines.length; n++) {
            line = lines[n].replace(/\r$/, "");
            if (!line) {
                continue;
            }
            p = line.split("\t");
            if (p.length < 3) {
                continue;
            }
            caps.push({ s: parseFloat(p[0]), e: parseFloat(p[1]), t: p.slice(2).join(" ") });
        }

        app.beginUndoGroup("Gerar legendas");
        opened = true;
        var feitas = 0;
        var semSombra = 0;
        var c, res;
        for (c = 0; c < caps.length; c++) {
            res = AL_createCaption(comp, caps[c], o, a, b);
            if (res > 0) {
                feitas++;
            }
            if (res === 2) {
                semSombra++;
            }
        }
        app.endUndoGroup();
        opened = false;
        return "OK|" + feitas + "|" + semSombra;
    } catch (e) {
        if (opened) {
            try { app.endUndoGroup(); } catch (x) {}
        }
        return "ERR|" + e.toString() + " (linha " + e.line + ")";
    }
}
