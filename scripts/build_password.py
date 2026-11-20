"""Erzeugt index_password.html (und kunden.html) aus index.html mit Passwortschutz.
Aufruf im Repo-Ordner: python3 scripts/build_password.py"""

PASSWORT = 'richtiganlegen'
src = open('index.html', encoding='utf-8').read()

CSS = """/* ── Passwort-Gate ── */
#pw-overlay { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 9999; }
.pw-box { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 40px; width: 340px; max-width: 86vw; text-align: center; box-sizing: border-box; }
.pw-logo { font-size: 18px; font-weight: 700; letter-spacing: .5px; color: var(--green); margin-bottom: 14px; }
.pw-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
.pw-sub { font-size: 12px; color: var(--muted); margin-bottom: 24px; }
.pw-input { width: 100%; background: var(--card2); border: 1px solid var(--border); border-radius: 8px; color: var(--fg); font-size: 15px; padding: 10px 14px; margin-bottom: 12px; box-sizing: border-box; text-align: center; letter-spacing: 2px; }
.pw-input:focus { outline: none; border-color: var(--green); }
.pw-btn { width: 100%; background: var(--green); border: none; border-radius: 8px; color: #0b0f1a; font-size: 14px; font-weight: 700; padding: 11px; cursor: pointer; }
.pw-btn:hover { opacity: 0.9; }
.pw-err { font-size: 12px; color: var(--red); margin-top: 10px; min-height: 16px; }
</style>"""

GATE = """<div id="app" style="display:none"><div style="color:var(--muted);padding:60px;text-align:center">Lade…</div></div>
<div id="pw-overlay">
  <div class="pw-box">
    <div class="pw-logo">RichtigAnlegen AG</div>
    <div class="pw-title">Antizyklisches Einstiegssignal</div>
    <div class="pw-sub">Bitte Passwort eingeben um fortzufahren</div>
    <input id="pw-input" class="pw-input" type="password" placeholder="Passwort" autocomplete="current-password" autofocus onkeydown="if(event.key==='Enter') doLogin()">
    <button class="pw-btn" onclick="doLogin()">Zugang</button>
    <div class="pw-err" id="pw-err"></div>
  </div>
</div>"""

LOGIN = """// init() wird erst nach erfolgreichem Login aufgerufen (siehe doLogin)
</script>
<script>
function doLogin() {
  const val = document.getElementById('pw-input').value;
  if (val === '%s') {
    document.getElementById('pw-overlay').style.display = 'none';
    document.getElementById('app').style.display = '';
    init();
  } else {
    document.getElementById('pw-err').textContent = 'Falsches Passwort';
    document.getElementById('pw-input').value = '';
    document.getElementById('pw-input').focus();
  }
}
</script>""" % PASSWORT

out = src.replace('</style>', CSS, 1)
app = '<div id="app"><div style="color:var(--muted);padding:60px;text-align:center">Lade…</div></div>'
assert app in out, 'app-div nicht gefunden'
out = out.replace(app, GATE, 1)
assert 'init();\n</script>' in out, 'init-Aufruf nicht gefunden'
out = out.replace('init();\n</script>', LOGIN, 1)
for name in ('index_password.html', 'kunden.html'):
    open(name, 'w', encoding='utf-8').write(out)
print('index_password.html und kunden.html erzeugt')
