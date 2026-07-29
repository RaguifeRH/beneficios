# Portal de Benefícios — o que mudou

## ⚠️ Antes de tudo: regra do Firestore

Tem uma **coleção nova** (`medical_slots`). Sem a regra abaixo, o calendário aparece vazio para o funcionário e o RH toma erro ao salvar. Adicione em `firestore.rules` e publique:

```
match /medical_slots/{id} {
  allow read: if true;                 // o funcionário precisa ler para montar o calendário
  allow write: if request.auth != null; // só RH logado escreve
}
```

Mesmo padrão que `benefits` já usa.

---

# Novidades

## 🩺 Agenda médica

**RH → aba Atendimentos** é o calendário do protótipo, funcionando como cadastro. Escolhe a filial no topo, navega pelos meses e **clica num dia para marcar** um atendimento. Clicar num compromisso existente abre para editar ou excluir.

Cada atendimento tem: **especialidade**, horário, profissional e observação. A especialidade define a cor e o ícone — os mesmos do protótipo, com as cores tiradas do PDF:

| | Especialidade | | | Especialidade |
|---|---|---|---|---|
| 🔵 | Clínica Geral | | 🔴 | Cardiologia |
| 🟢 | Fisioterapia Laboral | | 🔵 | Médico do Trabalho |
| 🟣 | Psiquiatria | | ⚫ | Outro |
| 🟠 | Atendimento Clínico (Fisioterapia) | | | |

Em **Outro**, use o campo "Nome exibido" para escrever o que for (ex.: "Vacinação da gripe"). Esse campo também serve para detalhar qualquer especialidade: "Cardiologia — retorno".

**Botão Imprimir**: gera o pôster em A4 paisagem, com logo e assinatura, igual ao protótipo. A barra lateral, os botões e as setas somem na impressão. O mês e a filial ficam no cabeçalho, então o papel sempre diz de quem é aquela agenda.

**RH → Configurações → Atendimentos médicos** guarda o link de agendamento, que é **um só** para todas as datas.

No celular, o funcionário vê o mesmo calendário em versão compacta: pontinhos coloridos nos dias marcados, legenda só das especialidades daquele mês, e a lista embaixo com a cor de cada especialidade na lateral.

Detalhes que valem saber:
- A filial é obrigatória — o funcionário só enxerga as datas da unidade dele. A lista de filiais vem da base de funcionários, então **importe os funcionários com a coluna Unidade antes** de cadastrar.
- Funcionário sem unidade cadastrada vê uma mensagem específica com o contato do RH, não uma tela vazia.
- Atendimento desmarcado como "visível" continua no calendário do RH, esmaecido, e some do portal.
- As datas usam o relógio local. Não caem no bug de fuso que eu tinha apontado no `dateOk()`.

## 💚 Apoio psicológico

**RH → Configurações → Apoio psicológico**: WhatsApp, nome e função, texto sobre sigilo.

Três decisões que tomei e você pode reverter:

1. **O link do WhatsApp vai sem mensagem pronta.** Quem decide o que dizer primeiro é a pessoa. Uma mensagem pré-preenchida do tipo "gostaria de conversar sobre apoio psicológico" fica no histórico do celular dela e pode ser lida por terceiros.
2. **O CVV (188) aparece como retaguarda 24h**, com uma caixinha para desligar. Recomendo deixar ligado: a psicóloga tem horário, e quem abre essa tela de madrugada precisa de algum lugar para ir.
3. A tela diz explicitamente que a empresa não vê a conversa.

## 🔒 Canal de denúncias

**RH → Configurações → Canal de denúncias**: link e um texto de "como funciona".

A tela avisa que o portal **não registra** quem abriu nem quem clicou — e isso é verdade no código: o app do funcionário não grava auditoria nenhuma. Sem essa garantia dita em voz alta, um canal de denúncias dentro de um portal com login por CPF simplesmente não é usado.

## Onde isso aparece

Bloco **"Saúde e apoio"** fixo no topo da home, com três atalhos lado a lado. Cada atalho **só aparece se estiver configurado** — então nada quebra enquanto você preenche aos poucos.

## Brinde: links validados

Aproveitei para fechar um dos pontos vermelhos da avaliação. Todo link (benefícios, denúncias, agendamento) passa por `safeUrl()`: só `https://`, `http://` e `mailto:`. Um link colado como `javascript:...` agora vira vazio em vez de executar script na tela do funcionário.

---

# Estrutura dos arquivos

```
index.html     ← portal do funcionário
rh.html        ← painel do RH

firebase.js    ← config + inicialização do Firebase
utils.js       ← CPF, datas, escape, URLs, cores
db.js          ← toda leitura/escrita no Firestore
brand.js       ← logos em Base64
```

**Suba os 6 juntos, na mesma pasta.** Sem build — eles se encontram por caminho relativo.

> Se o `service-worker.js` tiver lista fixa de cache, adicione os quatro `.js` e **troque a versão do cache**. Senão o navegador serve o HTML novo com o cache velho e a tela fica branca.

---

# Roteiro de teste

1. Publique a regra do `medical_slots`.
2. **RH → Configurações**: preencha os três blocos novos + o canal de ajuda. Salve e recarregue para confirmar que persistiu.
3. **RH → Atendimentos**: cadastre duas datas na mesma filial, uma neste mês e outra no mês que vem.
4. **No celular**, entre com o CPF de alguém dessa filial: os três atalhos devem aparecer. Abra a agenda, confira que o dia certo está marcado e navegue para o mês seguinte.
5. Entre com alguém de **outra filial** e confirme que a agenda dele é diferente.
6. Deixe o link do canal de denúncias vazio e confirme que o atalho **some** da home.
7. **Imprimir** a agenda (Ctrl+P) e conferir que sai em paisagem, com logo, sem a barra lateral.

---

# Rodada anterior (já aplicada)

- Núcleo unificado em 4 módulos — as cópias no `index.html` e no `rh.html` tinham divergido
- Canal de ajuda (WhatsApp/e-mail) no erro de login
- Máscara progressiva de CPF
- Esqueleto de carregamento no lugar do botão travado em "Entrando…"

# Ainda em aberto

- 🔴 Imagens em Base64 no Firestore — teto de 1 MB por documento
- 🟡 Importação apaga quem não está na planilha, sem confirmação
- 🟡 Service worker sem estratégia de offline confirmada
- 🟡 `alt=""` nos banners (acessibilidade)
- 🟡 `dateOk()` dos benefícios ainda lê datas como UTC (a agenda médica **não** tem esse problema)

# Ideia para depois

Se a mesma especialidade visita várias filiais no mesmo dia, hoje é preciso cadastrar uma vez por filial. Um botão "duplicar para outra filial" no modal resolveria — me avise se virar incômodo.
