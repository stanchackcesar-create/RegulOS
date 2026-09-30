from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 1) Backend: devolve também os nomes dos grupos atualmente permitidos.
server = ROOT / "src" / "server.js"
text = server.read_text(encoding="utf-8")
old = "grupos:groups.length, permitidos:allowed.length,"
new = "grupos:groups.length, permitidos:allowed.length, permitidosNomes:groups.filter(g=>allowed.includes(g.id)).map(g=>g.name).filter(Boolean),"
if old not in text:
    raise SystemExit("Não encontrei o trecho esperado do /api/status em src/server.js")
text = text.replace(old, new, 1)
server.write_text(text, encoding="utf-8")

# 2) Frontend: mostra os nomes dos grupos permitidos logo abaixo do contador.
index = ROOT / "public" / "index.html"
text = index.read_text(encoding="utf-8")
marker = '<span id="allowed" class="muted">0 permitidos</span>'
replacement = marker + '<div id="allowedNames" class="muted" style="margin-top:6px;font-size:12px">Grupos ligados: —</div>'
if "id=\"allowedNames\"" not in text:
    if marker not in text:
        raise SystemExit("Não encontrei o cartão de grupos em public/index.html")
    text = text.replace(marker, replacement, 1)

old_js = "document.getElementById('allowed').textContent=(d.permitidos||0)+' permitidos';"
new_js = old_js + "\n  const permitidosNomes=Array.isArray(d.permitidosNomes)?d.permitidosNomes:[];\n  document.getElementById('allowedNames').textContent=permitidosNomes.length?'Grupos ligados: '+permitidosNomes.join(', '):'Grupos ligados: —';"
if "permitidosNomes=Array.isArray(d.permitidosNomes)" not in text:
    if old_js not in text:
        raise SystemExit("Não encontrei a atualização do contador de grupos em public/index.html")
    text = text.replace(old_js, new_js, 1)

index.write_text(text, encoding="utf-8")
print("Patch de grupos selecionados aplicado com sucesso.")
