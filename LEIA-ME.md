# Portal de Benefícios — o que mudou

## Estrutura nova

Antes eram **2 arquivos**, cada um com uma cópia do mesmo núcleo. Agora são **6**, com o núcleo em um lugar só:

```
index.html     ← portal do funcionário  (1258 → 705 linhas)
rh.html        ← painel do RH           (2126 → 1407 linhas)

firebase.js    ← config + inicialização do Firebase   (era duplicado)
utils.js       ← CPF, datas, escape, cores            (era duplicado)
db.js          ← toda leitura/escrita no Firestore    (era duplicado E divergente)
brand.js       ← logos em Base64                      (era duplicado)
```

**Suba os 6 arquivos juntos, na mesma pasta.** Eles se encontram por caminho relativo (`./db.js`), sem build.

> ⚠️ Se o seu `service-worker.js` tiver uma lista fixa de arquivos para cache, adicione os quatro `.js` novos e **troque a versão do cache** — senão o navegador serve o `index.html` novo com o cache velho e a tela fica em branco.

---

## 1. Núcleo unificado

As duas cópias já tinham divergido: o `rh.html` tinha as **regras de perfil** (Sindicato + Tipo → Perfil) e o `index.html` ainda usava a versão antiga sem regras. Adotei a versão do RH como oficial — nada quebra, porque o portal do funcionário só lê `profileIds` já gravados.

De agora em diante, uma correção em `db.js` vale para os dois lados automaticamente.

## 2. Canal de ajuda no erro de login

O erro antigo era *"CPF não encontrado na base ativa. Procure o RH/DP."* — sem dizer como.

Agora, em **Configurações → Canal de ajuda**, o RH preenche:
- **WhatsApp** (só números, com DDI e DDD: `5511999999999`)
- **E-mail**

O funcionário que erra o login vê botões diretos, com mensagem já preenchida no WhatsApp. Se nenhum dos dois estiver configurado, volta ao texto genérico — **vale preencher no primeiro acesso.**

## 3. Máscara de CPF

O campo agora formata enquanto a pessoa digita: `123` → `123.4` → `123.456.789-01`. Aceita CPF colado já formatado, ignora letras e corta o excesso.

## 4. Esqueleto de carregamento

Antes o botão ficava travado em "Entrando…" durante as 4 consultas ao Firestore. Agora, assim que o CPF é aceito, a home aparece com placeholders animados no lugar dos cards. Vale também ao reabrir o app com sessão salva.

Bônus: falha de rede no login agora tem mensagem própria ("Verifique sua internet") em vez de cair na tela de erro genérica.

---

## Como testar

1. **Login errado** → digite um CPF que não existe. Deve aparecer o botão de WhatsApp (depois de configurar em Configurações).
2. **Máscara** → digite números soltos e veja os pontos aparecerem sozinhos.
3. **Esqueleto** → no celular, com rede lenta (DevTools → Network → Slow 3G), faça login: a home deve aparecer cinza antes de preencher.
4. **RH** → salve Configurações e confirme que WhatsApp e e-mail persistem depois de recarregar.

## O que ficou de fora (da avaliação anterior)

- 🔴 Links de benefício não validam protocolo — `javascript:` ainda passa
- 🔴 Imagens em Base64 no Firestore — teto de 1 MB por documento
- 🟡 `dateOk()` lê datas como UTC (3h de defasagem no Brasil)
- 🟡 Importação apaga quem não está na planilha, sem confirmação
- 🟡 Service worker sem estratégia de offline confirmada
- 🟡 `alt=""` nos banners (acessibilidade)
