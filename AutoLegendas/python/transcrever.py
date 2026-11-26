#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Transcreve um video/audio com faster-whisper e agrupa as palavras em legendas.

Saida (TSV, UTF-8), uma legenda por linha:
    inicio<TAB>fim<TAB>texto
Os tempos sao em segundos, no tempo do arquivo original.

Agrupamento (modo "phrase", o padrao): cada FRASE fica inteira em uma legenda.
  - a frase termina onde o Whisper termina o segmento, depois de . ? ! ...,
    numa pausa >= --pause, ou numa virgula acompanhada de respiracao (--comma-pause)
  - virgula sem pausa NAO corta a frase
  - a frase e distribuida em ate --max-lines linhas de --max-chars caracteres
    (linhas balanceadas, sem palavra sozinha pendurada)
  - so se a frase nao couber nisso ela e dividida em legendas, de preferencia
    depois de uma virgula ou pausa
  - palavras de uma frase nunca aparecem na legenda da frase seguinte
Modo "chunks": blocos de poucas palavras (--max-words), sempre dentro de uma frase.
"""
import argparse
import io
import math
import os
import re
import sys

HARD_END = ('.', '?', '!', '\u2026')
SOFT_END = (',', ';', ':', '\u2014', '\u2013')
CLOSERS = '"\')]\u00bb\u201d\u2019'

# Remocao de pontuacao (feita DEPOIS de agrupar as frases, porque a pontuacao
# ainda serve para decidir onde cortar). Numeros como 3.5 ou 10:30 ficam intactos.
_PUNCT_BASIC = re.compile(u'(?<!\\d)[.,\u2026]+|[.,\u2026]+(?!\\d)')
_PUNCT_ALL = re.compile(u'(?<!\\d)[.,\u2026!?;:\u00bf\u00a1]+|[.,\u2026!?;:\u00bf\u00a1]+(?!\\d)')


def strip_punct(text, mode):
    """mode 0 = manter tudo, 1 = remover . , ... ; 2 = remover tambem ! ? ; :"""
    if mode == 1:
        text = _PUNCT_BASIC.sub('', text)
    elif mode >= 2:
        text = _PUNCT_ALL.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()


def _ends_with(token, marks):
    return token.strip().rstrip(CLOSERS).endswith(marks)


def _join(part):
    return ' '.join(w['word'].strip() for w in part)


def _wlen(words):
    """Tamanho em caracteres de uma linha formada por essas palavras."""
    return sum(len(w['word'].strip()) for w in words) + max(0, len(words) - 1)


def _even_sizes(n, k):
    base, extra = divmod(n, k)
    return [base + 1 if i < extra else base for i in range(k)]


def _split_balanced(group, max_words, max_chars):
    """Modo 'blocos curtos': divide UMA frase em partes de tamanho parecido."""
    n = len(group)
    k = max(1, int(math.ceil(n / float(max_words))))
    while True:
        parts, idx = [], 0
        for size in _even_sizes(n, k):
            parts.append(group[idx:idx + size])
            idx += size
        fits = all(len(_join(p)) <= max_chars or len(p) == 1 for p in parts)
        if fits or k >= n:
            return parts
        k += 1


def _is_weak(token):
    return re.sub(r"[^\w']", '', token).lower() in _WEAK_END


def _starts_sentence(token):
    """True se a palavra comeca com maiuscula e nao e o pronome 'I' (que e maiusculo em qualquer lugar)."""
    t = re.sub(r"^[^\w]+", '', token)
    if not t or not t[0].isalpha() or not t[0].isupper():
        return False
    return re.sub(r"[^\w']", '', t).lower() not in ('i', "i'm", "i'll", "i've", "i'd", "i’m", "i’ll", "i’ve", "i’d")


def phrase_groups(words, pause=0.45, comma_pause=0.20, cap_pause=0.12):
    """Agrupa as palavras em FRASES. Uma frase termina quando:
      - o Whisper termina o segmento (e ele quem separa as falas / versos);
      - a palavra termina em . ? ! ...;
      - existe uma pausa >= `pause` segundos entre duas palavras;
      - a palavra termina em , ; : e existe uma respiracao >= `comma_pause`;
      - a proxima palavra comeca com letra MAIUSCULA (inicio de frase) e ha uma respiracao
        >= `cap_pause` (ou a palavra atual termina em virgula), desde que a palavra atual
        nao seja uma palavra fraca (the, a, de...).
    A virgula SEM pausa nao corta a frase.
    As palavras de uma frase nunca vao para a legenda da frase seguinte."""
    groups, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None:
            cut = True
        elif w.get('seg') != nxt.get('seg'):
            cut = True
        elif _ends_with(w['word'], HARD_END):
            cut = True
        elif nxt['start'] - w['end'] >= pause:
            cut = True
        elif _ends_with(w['word'], SOFT_END) and nxt['start'] - w['end'] >= comma_pause:
            cut = True
        elif (_starts_sentence(nxt['word']) and not _is_weak(w['word'])
              and (nxt['start'] - w['end'] >= cap_pause or _ends_with(w['word'], SOFT_END))):
            cut = True
        else:
            cut = False
        if cut:
            groups.append(cur)
            cur = []
    return groups


# palavras que ficam feias no fim de uma linha (a linha deve terminar em outra coisa)
_WEAK_END = set(['i', 'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'my', 'me', 'we', 'and',
                 'or', 'but', 'if', 'is', 'it', 'de', 'do', 'da', 'no', 'na', 'o', 'e', 'um',
                 'uma', 'que', 'se', 'eu', 'um', 'em', 'com', 'por', 'pra', 'para'])


def _line_end_penalty(words, j, m):
    """Custo extra de terminar uma linha na palavra words[j-1] (so entre divisoes parecidas)."""
    if j >= m:
        return 0
    tok = words[j - 1]['word']
    if _ends_with(tok, SOFT_END + HARD_END):
        return -25
    if re.sub(r'\W', '', tok).lower() in _WEAK_END:
        return 30
    return 0


def _balanced_lines(words, n, max_chars):
    """Divide as palavras em n linhas. Primeiro garante que nenhuma linha passe de
    max_chars (se der); entre as divisoes que cabem, prefere linhas de tamanho
    parecido, quebrando depois de virgula e nao em palavras fracas (I, a, the...)."""
    m = len(words)
    n = max(1, min(n, m))
    pre = [0]
    for w in words:
        pre.append(pre[-1] + len(w['word'].strip()))

    def seg_len(i, j):
        return pre[j] - pre[i] + (j - i - 1)

    INF = (10 ** 9, 10 ** 9)
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    cut = [[0] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = (0, 0)
    for k in range(1, n + 1):
        for j in range(k, m + 1):
            for i in range(k - 1, j):
                prev = dp[k - 1][i]
                if prev == INF:
                    continue
                L = seg_len(i, j)
                cand = (max(prev[0], max(0, L - max_chars)),
                        prev[1] + L * L + _line_end_penalty(words, j, m))
                if cand < dp[k][j]:
                    dp[k][j] = cand
                    cut[k][j] = i
    lines, j = [], m
    for k in range(n, 0, -1):
        i = cut[k][j]
        lines.append(words[i:j])
        j = i
    lines.reverse()
    return lines


def _split_parts(group, k):
    """Divide uma frase MUITO longa em k legendas, preferindo cortar depois de
    virgula ou onde ha uma pausa."""
    m = len(group)
    k = max(1, min(k, m))
    total = float(_wlen(group))
    cuts, prev = [], 0
    for t in range(1, k):
        ideal = total * t / k
        best, best_score = None, None
        for c in range(prev + 1, m - (k - t) + 1):
            score = abs(_wlen(group[:c]) - ideal) / max(1.0, total / k)
            if _ends_with(group[c - 1]['word'], SOFT_END):
                score -= 0.35
            if c < m:
                score -= min(0.5, max(0.0, group[c]['start'] - group[c - 1]['end']))
            if best is None or score < best_score:
                best, best_score = c, score
        cuts.append(best)
        prev = best
    parts, s0 = [], 0
    for c in cuts + [m]:
        parts.append(group[s0:c])
        s0 = c
    return parts


def layout_phrase(group, max_chars, max_lines):
    """Modo 'frase inteira': devolve a lista de legendas dessa frase; cada legenda
    e uma lista de LINHAS (cada linha, uma lista de palavras). A frase fica junta
    em uma legenda de 1 ate max_lines linhas; so se nao couber ela e dividida."""
    if len(group) == 1 or _wlen(group) <= max_chars:
        return [[group]]
    for n in range(2, max(2, max_lines) + 1):
        if n > len(group):
            break
        lines = _balanced_lines(group, n, max_chars)
        if max(_wlen(l) for l in lines) <= max_chars:
            return [lines]
    k = max(2, int(math.ceil(_wlen(group) / float(max_chars * max(1, max_lines) * 0.9))))
    out = []
    for part in _split_parts(group, k):
        out.extend(layout_phrase(part, max_chars, max_lines))
    return out


def build_captions(words, mode='phrase', max_words=4, max_chars=24, max_lines=2,
                   pause=0.45, comma_pause=0.20, cap_pause=0.12):
    """Devolve a lista de legendas; cada legenda e uma lista de linhas de palavras."""
    caps = []
    for g in phrase_groups(words, pause, comma_pause, cap_pause):
        if mode == 'chunks':
            for part in _split_balanced(g, max_words, max_chars):
                caps.append([part])
        else:
            caps.extend(layout_phrase(g, max_chars, max(1, max_lines)))
    return caps


def _cap_text(cap):
    return '\n'.join(_join(line) for line in cap)


def build_timeline(caps, lead=0.05, tail=0.15, fill_gap=0.45, min_dur=0.30):
    """Define entrada/saida de cada legenda sem sobreposicao."""
    items = []
    for cap in caps:
        ws = [w for line in cap for w in line]
        items.append({'text': _cap_text(cap), 'start': ws[0]['start'], 'end': ws[-1]['end']})
    out, prev_end = [], 0.0
    for i, c in enumerate(items):
        start = max(c['start'] - lead, prev_end, 0.0)
        end = c['end'] + tail
        nxt = None
        if i + 1 < len(items):
            nxt = max(items[i + 1]['start'] - lead, start + 0.05)
            if nxt - c['end'] <= fill_gap:
                end = nxt  # pausa curta: segura a legenda ate a proxima entrar
        end = max(end, start + min_dur)
        if nxt is not None:
            end = min(end, nxt)  # nunca invade a proxima
        out.append({'text': c['text'], 'start': start, 'end': end})
        prev_end = end
    return out


def patch_av():
    """av 19+ removeu metadata_errors/metadata_encoding de av.open, mas o faster-whisper
    ainda os envia. Se o av recusar esses argumentos, repete a chamada sem eles."""
    try:
        import av
    except ImportError:
        return
    original = av.open

    def compat_open(*a, **k):
        try:
            return original(*a, **k)
        except TypeError as e:
            if 'metadata_' not in str(e):
                raise
            k.pop('metadata_errors', None)
            k.pop('metadata_encoding', None)
            return original(*a, **k)

    av.open = compat_open


def add_nvidia_dlls():
    """Se as bibliotecas CUDA foram instaladas via pip (nvidia-cublas-cu12 etc.), no Windows
    suas DLLs ficam dentro do site-packages e precisam ser registradas para o Whisper achar."""
    if os.name != 'nt':
        return
    try:
        import nvidia
        bases = list(getattr(nvidia, '__path__', []))
    except Exception:
        return
    for base in bases:
        for sub in ('cublas', 'cudnn', 'cuda_runtime'):
            d = os.path.join(base, sub, 'bin')
            if os.path.isdir(d):
                try:
                    os.add_dll_directory(d)
                except Exception:
                    pass
                os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='small')
    ap.add_argument('--lang', default='auto')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--end', type=float, default=0.0)
    ap.add_argument('--max-words', type=int, default=4)
    ap.add_argument('--max-chars', type=int, default=24)
    ap.add_argument('--max-lines', type=int, default=2)
    ap.add_argument('--mode', default='phrase', choices=['phrase', 'chunks'])
    ap.add_argument('--comma-pause', type=float, default=0.20)
    ap.add_argument('--cap-pause', type=float, default=0.12)
    ap.add_argument('--pause', type=float, default=0.45)
    ap.add_argument('--min-soft', type=int, default=2)
    ap.add_argument('--vad', action='store_true')
    ap.add_argument('--punct', type=int, default=0)
    ap.add_argument('--device', default='cpu', choices=['cpu', 'auto'])
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print('ERRO ao carregar o faster-whisper: %s' % e)
        print('      Python usado: %s (%s)' % (sys.version.split()[0], sys.executable))
        print('      Clique em "Instalar dependencias" no painel.')
        sys.exit(2)

    patch_av()
    add_nvidia_dlls()

    kwargs = dict(
        word_timestamps=True,
        condition_on_previous_text=False,
        beam_size=5,
        # o padrao do Whisper pula trechos que "parecem silencio" (fala baixa, musica ou efeito
        # por cima) e por isso as legendas so comecavam la na frente. Desligado.
        no_speech_threshold=None,
        log_prob_threshold=None,
    )
    if args.lang != 'auto':
        kwargs['language'] = args.lang

    ranged = args.end > args.start
    if args.vad:
        kwargs['vad_filter'] = True  # o VAD e ignorado com clip_timestamps; filtramos depois
        kwargs['vad_parameters'] = dict(threshold=0.30, min_silence_duration_ms=700, speech_pad_ms=300)
    elif ranged:
        kwargs['clip_timestamps'] = '%.3f,%.3f' % (args.start, args.end)

    def run_on(device):
        where = 'no processador (CPU)' if device == 'cpu' else 'automatico (placa de video se houver)'
        print('Carregando modelo %s %s (na primeira vez ele e baixado)...' % (args.model, where))
        model = WhisperModel(args.model, device=device, compute_type='int8')
        print('Transcrevendo...')
        found = []
        segments, inf = model.transcribe(args.file, **kwargs)
        for si, seg in enumerate(segments):
            for w in (seg.words or []):
                text = (w.word or '').strip()
                if not text:
                    continue
                found.append({'word': text, 'start': float(w.start), 'end': float(w.end), 'seg': si})
        return found, inf

    # 'auto' tenta a placa de video e, se faltar alguma biblioteca CUDA, cai para a CPU
    order = ['cpu'] if args.device == 'cpu' else ['auto', 'cpu']
    words, info = [], None
    for dev in order:
        try:
            words, info = run_on(dev)
            break
        except TypeError as e:
            if 'metadata_errors' in str(e):
                print('ERRO: a versao instalada da biblioteca "av" nao e compativel.')
                print('      Clique em "Instalar dependencias" no painel e tente de novo.')
                sys.exit(2)
            raise
        except (RuntimeError, ValueError) as e:
            msg = str(e).lower()
            gpu_problem = any(k in msg for k in ('cublas', 'cudnn', 'cuda', 'cufft', 'curand'))
            if dev != 'cpu' and gpu_problem:
                print('Aviso: a placa de video nao funcionou (%s).' % e)
                print('       Usando o processador (CPU)...')
                continue
            raise

    if ranged:
        words = [w for w in words
                 if w['start'] >= args.start - 0.2 and w['end'] <= args.end + 0.2]

    if not words:
        print('ERRO: nenhuma fala encontrada no trecho selecionado.')
        sys.exit(3)

    first, last = words[0]['start'], words[-1]['end']
    span_a = args.start if ranged else 0.0
    print('Fala encontrada de %.1fs ate %.1fs no arquivo (trecho analisado: %.1fs ate %s).'
          % (first, last, span_a, ('%.1fs' % args.end) if ranged else 'o fim'))
    if first - span_a > 8.0:
        print('Aviso: a primeira fala so aparece %.0fs depois do inicio do trecho.' % (first - span_a))
        print('       Se tem fala antes disso: desmarque "Filtrar silencio", escolha o idioma')
        print('       em vez de "auto" e use o modelo medium. Se o audio escolhido nao era o certo,')
        print('       selecione na timeline a camada exata da fala.')
    caps = build_captions(words, args.mode, args.max_words, args.max_chars, args.max_lines,
                          args.pause, args.comma_pause, args.cap_pause)
    items = build_timeline(caps)

    # quebra de linha dentro da legenda vai como a sequencia \n (barra + n); o host.jsx converte
    written = 0
    with io.open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        for c in items:
            lines = [strip_punct(l.replace('\t', ' '), args.punct) for l in c['text'].split('\n')]
            lines = [l for l in lines if l]
            if not lines:
                continue
            f.write(u'%.3f\t%.3f\t%s\n' % (c['start'], c['end'], u'\\n'.join(lines)))
            written += 1

    print('OK %d legendas (idioma detectado: %s)' % (written, getattr(info, 'language', '?')))


if __name__ == '__main__':
    main()
