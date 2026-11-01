import type { Catalog } from '..'

export const connect: Catalog['connect'] = {
  blurbClaudeCode: 'Conecte pelo seu terminal',
  blurbClaude: 'Adicione o Doop ao Claude',
  blurbChatgpt: 'Conecte pelo navegador',
  blurbCodex: 'ChatGPT desktop e Codex CLI',
  blurbCursor: 'Adicione o Doop ao Cursor',
  otherClientName: 'Outro cliente MCP',
  blurbOtherClient: 'Use uma conexão manual',

  chooseTitle: 'Escolha seu agente',
  chooseLede:
    'Deixe um agente que você já usa trabalhar neste canvas via MCP. Escolha o seu para ver as instruções de conexão.',
  connectButton: 'Conectar',

  pointAtTitle: 'Aponte-o para este canvas',
  pointAtWithPrompt: 'Cole isto como sua primeira mensagem. Todo o resto de que o agente precisa vem do servidor.',
  pointAtNoPrompt:
    'Abra um canvas e peça ao agente para trabalhar nele. Todo o resto de que ele precisa vem do servidor.',
  approveSignInTitle: 'Aprove o login',

  claudeCodeLede: 'Três passos, cerca de um minuto. Depois o Claude Code desenha neste canvas em seu nome.',
  claudeCodeAddTitle: 'Adicione o Doop como servidor MCP',
  claudeCodeAddBefore: 'Execute isto uma vez em qualquer terminal. Isso registra o servidor ',
  claudeCodeAddAfter: ' para todos os projetos.',
  claudeCodeSignInTitle: 'Entre pelo Claude Code',
  claudeCodeSignInBefore: 'No Claude Code, digite ',
  claudeCodeSignInPick: ', escolha ',
  claudeCodeSignInThen: ' e depois ',
  claudeCodeSignInAfter: '. Uma aba do navegador se abre para você aprovar a conexão.',

  claudeDesktopLede: 'Adicione o Doop pelo app desktop, confirme no Claude e comecem a desenhar juntos.',
  claudeDesktopAddTitle: 'Adicione o Doop ao Claude Desktop',
  claudeDesktopAddBody:
    'Clique em Adicionar ao Claude no app desktop do Doop e confirme a instalação no Claude. O endereço do seu servidor Doop já vem preenchido.',
  claudeDesktopConnectTitle: 'Conecte sua conta Doop',
  claudeDesktopConnectBody: 'Ative a extensão no Claude. Entre no Doop no navegador que se abrir e aprove a conexão.',
  claudeDesktopPointWithPrompt:
    'Inicie um novo chat no Claude, ative o Doop no menu de ferramentas e envie isto como sua primeira mensagem.',
  claudeDesktopPointNoPrompt:
    'Inicie um novo chat no Claude, ative o Doop no menu de ferramentas e diga em qual canvas ele deve trabalhar.',

  claudePublicLede: 'O conector online do Claude precisa de um servidor HTTPS acessível publicamente.',
  claudeLocalTitle: 'Use a conexão desktop para este servidor',
  claudeLocalBody:
    'Este endereço do Doop é local ou usa HTTP. Escolha App desktop acima para conectar pelo seu computador, ou abra o Doop no endereço HTTPS público dele.',

  claudeWebLede: 'Adicione o Doop à sua conta Claude, aprove a conexão e comece a desenhar. Sem download.',
  claudeWebAddTitle: 'Adicione o Doop ao Claude',
  claudeWebAddBody:
    'Abra o Claude com o nome e o endereço do servidor do Doop já preenchidos. Revise os detalhes e adicione o conector.',
  addToClaude: 'Adicionar ao Claude',
  claudeWebApproveBody: 'Clique em Connect no novo conector. Uma aba do navegador se abre para você aprovar a conexão.',
  claudeWebPointWithPrompt:
    'Em um novo chat, ative o Doop no menu de ferramentas e envie isto como sua primeira mensagem.',
  claudeWebPointNoPrompt:
    'Em um novo chat, ative o Doop no menu de ferramentas e diga em qual canvas ele deve trabalhar.',

  chatgptPublicLede:
    'O ChatGPT precisa de um endereço HTTPS público ou de um túnel seguro para acessar este servidor Doop.',
  chatgptReachTitle: 'Torne seu servidor Doop acessível',
  chatgptReachBody:
    'O ChatGPT não consegue acessar este endereço diretamente. Abra o endereço HTTPS público do seu Doop e inicie esta conexão por lá, ou configure um OpenAI Secure MCP Tunnel para este servidor.',
  chatgptGuide: 'Ver guia de configuração do ChatGPT',

  chatgptLede: 'Sem download. Abra o ChatGPT, cole o endereço do servidor abaixo e aprove a conexão com o Doop.',
  chatgptOpenTitle: 'Abra os plugins do ChatGPT',
  chatgptOpenBefore: 'Clique no botão ',
  chatgptOpenMiddle: ' na página Plugins e depois em ',
  chatgptOpenAfter: '. Sua conta ou workspace precisa permitir servidores personalizados.',
  chatgptOpenButton: 'Abrir configuração do ChatGPT',
  chatgptAddTitle: 'Adicione o Doop e entre',
  chatgptAddBefore: 'Dê o nome ',
  chatgptAddDescribe: ', descreva-o como um canvas de design e cole isto como URL do servidor MCP. Escolha ',
  chatgptAddReview: ', revise as permissões e selecione ',
  chatgptAddAfter: '. Entre no Doop quando solicitado e instale o plugin criado.',
  chatgptPointWithPrompt:
    'Inicie um novo chat, digite @ e selecione Doop, depois envie isto como sua primeira mensagem.',
  chatgptPointNoPrompt:
    'Inicie um novo chat, digite @ e selecione Doop, depois diga em qual canvas ele deve trabalhar.',

  codexLede: 'Adicione o Doop pelo app desktop, entre e comece a desenhar com o Codex.',
  codexAddTitle: 'Adicione o Doop ao Codex',
  codexAddBody:
    'O Doop Desktop configura o Codex para você. Funciona com o Codex CLI e com a aba Codex no app desktop do ChatGPT.',
  codexSignInTitle: 'Entre pelo Codex',
  codexSignInBody:
    'Abra um novo chat no Codex. Se o Doop pedir autenticação, entre pelas configurações de MCP dele. No Codex CLI, execute o comando abaixo e aprove a conexão no navegador.',

  cursorLede: 'Adicione o Doop ao Cursor, entre e comecem a desenhar juntos.',
  cursorAddTitle: 'Adicione o Doop ao Cursor',
  cursorAddBody: 'Abra o Cursor e revise a conexão com o servidor. Nenhum arquivo para baixar.',
  cursorApproveBody:
    'Ative o servidor doop no Cursor e conclua o login pelo navegador. Depois disso, seu agente pode trabalhar nos canvases a que você tem acesso.',
  cursorPointWithPrompt: 'Abra o chat do Agent e envie isto como sua primeira mensagem.',
  cursorPointNoPrompt: 'Abra o chat do Agent e diga em qual canvas ele deve trabalhar.',

  mcpLede: 'O Doop é um servidor MCP streamable-HTTP com OAuth. Qualquer cliente com esse suporte pode desenhar aqui.',
  mcpConfigTitle: 'Adicione este servidor à configuração MCP do seu cliente',
  mcpConfigBefore: 'Windsurf, Zed, Cline e VS Code leem um arquivo JSON como este. Cole nele a entrada ',
  mcpConfigAfter: '.',
  mcpApproveBody:
    'Na primeira vez que seu cliente se conectar, uma aba do navegador se abre para autorizá-lo. Depois o agente trabalha em seu nome, e as edições dele são atribuídas a você.',

  connectAgentTitle: 'Conectar {name}',
  claudeMethodAria: 'Forma de conexão do Claude',
  desktopApp: 'App desktop',
  connectOnline: 'Conectar online',
  connectionHelp: 'Ajuda com a conexão',
  helpBefore:
    'Se o Claude pedir para você entrar primeiro, volte aqui e clique em Adicionar ao Claude de novo. Você também pode usar ',
  helpAfter: ' no Claude com este endereço:',
  headlessBefore: 'Sem navegador para fazer login (n8n, Mastra, CI)? Gere uma chave de agente em ',
  headlessLink: 'Configurações → Chaves de agente',
  headlessMiddle: ' e envie-a como ',
  headlessAfter: '. A chave age em seu nome, nos canvases a que você tem acesso.',
  done: 'Concluído',

  arrived: '{name} chegou. Funcionou',
  listening: 'aguardando {name}…',
  yourAgent: 'seu agente',

  codexSetupTitle: 'Abra o servidor Doop correspondente',
  codexSetupBody:
    'Este link de configuração é de outro servidor Doop ou está incompleto. Abra o Connect AI no app desktop desse servidor, ou use a configuração manual do Codex no navegador.',
  backToDoop: 'Voltar ao Doop',
}
