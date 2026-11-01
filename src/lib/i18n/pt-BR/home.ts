import type { Catalog } from '..'

export const home: Catalog['home'] = {
  /* header */
  manage: 'Gerenciar',
  import: 'Importar',
  newCanvas: 'Novo canvas',
  newShort: 'Novo',

  /* failures and toasts */
  createCanvasFailed: 'Não foi possível criar o canvas',
  startCanvasFailed: 'Não foi possível iniciar o canvas',
  startImportFailed: 'Não foi possível iniciar a importação',
  briefNotQueued: 'O briefing não entrou na fila. Tente enviá-lo de novo',
  duplicateFailed: 'Não foi possível duplicar o canvas',
  shareFailed: 'Não foi possível abrir o compartilhamento',
  linkCopied: 'Link do canvas copiado',
  movedTo: 'Movido para {name}',
  movedToFallback: 'o workspace',
  movedToPersonal: 'Movido para Pessoal',

  /* upgrade reasons */
  reasonAddCanvas: 'Adicionar um canvas a um workspace exige um plano Team.',
  reasonMoveCanvas: 'Mover um canvas para um workspace exige um plano Team.',
  reasonWorkspaceReady: '"{name}" está pronto. Escolha um plano para começar a usá-lo.',

  /* scopes */
  ownedByMe: 'Meus canvases',
  sharedWithMe: 'Compartilhados comigo',
  allCanvases: 'Todos os canvases',

  /* a workspace without a plan */
  noPlanTitle: '{name} ainda não tem plano.',
  noPlanAskOwner: 'Peça ao dono para escolher um. Até lá, nenhum canvas pode ser adicionado aqui.',
  noPlanChoose: 'Escolha um plano Team para adicionar canvases e convidar sua equipe.',
  choosePlan: 'Escolher um plano',

  /* list header */
  people: { one: '{count} pessoa', other: '{count} pessoas' },
  teamPlan: 'Plano Team',
  sharedWorkspace: 'Workspace compartilhado',
  noPlanYet: 'Ainda sem plano',
  sortAria: 'Ordenar: {label}',
  sortUpdated: 'Última edição',
  sortName: 'Nome',
  sortCreated: 'Mais recentes',
  viewAria: 'Visualização',
  gridView: 'Visualização em grade',
  listView: 'Visualização em lista',

  /* list body */
  emptyTitle: 'Comece seu primeiro canvas',
  emptyDescription:
    'Um canvas é um espaço compartilhado de frames HTML ao vivo: você desenha no navegador, seus agentes de IA desenham via MCP e todos acompanham tudo acontecer em tempo real.',
  createCanvas: '+ Criar um canvas',
  nothingHere: 'Nada aqui ainda. Tente outro filtro.',
  createNewCanvasAria: 'Criar um novo canvas',
  frames: { one: '{count} frame', other: '{count} frames' },

  /* delete */
  deleteTitle: 'Excluir “{name}”?',
  deleteFallbackName: 'canvas',
  deleteDescription: 'Isso exclui permanentemente o canvas e tudo o que há nele. Não dá para desfazer.',
  deleteConfirm: 'Excluir canvas',

  /* tile meta */
  claimTitle: 'Este canvas é anterior às contas e fica visível para todos. Reivindique-o para torná-lo seu.',
  claimBadge: 'Tornar meu',
  sharedByTitle: 'Você foi convidado para colaborar neste canvas',
  sharedBy: 'Compartilhado por {name}',
  edited: 'Editado {time}',
  inWorkspace: 'No workspace {workspace}',

  /* canvas actions */
  actionsFor: 'Ações de {name}',
  share: 'Compartilhar',
  duplicating: 'Duplicando…',
  duplicate: 'Duplicar',
  move: 'Mover…',
  moveToWorkspace: 'Mover para um workspace…',

  /* hero */
  greeting: 'Me diga o que desenhar',
  chipLanding: 'Criar uma landing page',
  chipLandingPrompt: 'Crie uma landing page para ',
  chipRecap: 'Resumir uma sessão',
  chipRecapPrompt: 'Resuma o que aconteceu nos meus canvases esta semana, em um único frame de resumo.',
  chipChanged: 'O que mudou',
  chipChangedPrompt: 'O que mudou nos meus canvases esta semana?',
  chipAutomation: 'Rodar uma automação',
  chipAgents: 'Conectar seus agentes',
  chipImport: 'Importar um design',
  chipComments: 'Revisar comentários',
  chipCommentsPrompt: 'Percorra os comentários abertos nos meus canvases e resolva cada um.',
  composerPlaceholder: 'O que mudou nos meus canvases esta semana?',
  composerAria: 'Diga ao Doop o que desenhar',
  attachTitle: 'Anexe um design para começar',
  files: 'Arquivos',
  draftsAria: 'Rascunhos por prompt: {count}',
  drafts: { one: '{count} rascunho', other: '{count} rascunhos' },
  draftsCaption: 'Rascunhos por prompt',
  draftsDescription: { one: 'Uma versão do briefing', other: '{count} versões, lado a lado, para escolher' },
  send: 'Enviar',
  connectDesigns: 'Conecte seus designs existentes para resultados melhores',

  /* agent allowance */
  meterGeminiCloud: 'Doop Agent na sua conexão do Gemini na nuvem',
  meterClaudeLocal: 'Doop Agent no seu Claude CLI local',
  meterChatgpt: 'Doop Agent no seu ChatGPT',
  meterProviderKey: 'Doop Agent na sua chave da {provider}',
  meterNoFreeTier: 'Conecte um plano em Configurações para usar o Doop Agent',
  meterUsedUp: 'Tarefas gratuitas do Doop Agent esgotadas. Conecte o ChatGPT para continuar',
  meterUsedUpLine: 'tarefas gratuitas do Doop Agent esgotadas. Conecte o ChatGPT para continuar',
  meterLeft: {
    one: '{left} de {count} tarefa gratuita do Doop Agent restante',
    other: '{left} de {count} tarefas gratuitas do Doop Agent restantes',
  },
  wallUsedUpTitle: 'Suas tarefas gratuitas do Doop Agent acabaram',
  wallConnectTitle: 'Conecte um plano para usar o Doop Agent',
  wallUsedUpBefore: 'Essas foram por nossa conta. Conecte sua',
  wallUsedUpBold: 'assinatura do ChatGPT',
  wallUsedUpAfter:
    'e o Doop Agent continua trabalhando exatamente como agora: mesmo canvas, mesmo agente, rodando no seu plano em vez do nosso.',
  wallConnectBefore: 'O Doop Agent desenha nos seus canvases usando uma assinatura que você já tem. Conecte o',
  wallConnectAfter: 'uma vez e cada tarefa roda no seu plano: nada medido, nenhuma cobrança à parte.',
  wallConnectButton: 'Conectar seu plano',
  wallMcp:
    'Prefere conduzir o canvas você mesmo pelo Claude Code, Codex ou outro cliente MCP? Esse agente desenha conforme você o instrui, enquanto as tarefas na fila ficam com o Doop Agent.',
  wallMcpLink: 'Veja como conectá-lo',

  /* create a workspace */
  workspacesEyebrow: 'Workspaces',
  nameWorkspace: 'Dê um nome ao seu workspace',
  createWorkspaceLede:
    'Um workspace é a casa compartilhada da sua equipe: todos nele podem abrir qualquer canvas que estiver lá dentro. Você pode mover canvases existentes para ele depois.',
  workspaceNameAria: 'Nome do workspace',
  creating: 'Criando…',
  createWorkspace: 'Criar workspace',
  createWorkspaceFailed: 'Não foi possível criar o workspace',

  /* the upgrade wall */
  upgradeEyebrow: 'Plano Team · {price} por assento por mês',
  plansFor: 'Planos para {name}',
  unlock: 'Desbloquear {name}',
  plans: 'Planos',
  upgradeDefaultReason: 'Workspaces compartilhados são a parte paga do doop.',
  upgradeLede:
    'Todos em um workspace abrem qualquer canvas dele: sem convites por canvas, sem links para repassar. Os assentos são cobrados conforme as pessoas entram e reembolsados conforme saem.',
  billingOff:
    'A cobrança não está configurada neste servidor, então os workspaces estão incluídos. Nada para comprar. Vá criar um.',
  monthly: 'Mensal',
  yearly: 'Anual',
  yearlyPrice: '{perMonth} por assento por mês, cobrado {perYear} por ano',
  monthlyPrice: '{price} por assento, cobrado mensalmente',
  seats: { one: '{count} assento × {price}', other: '{count} assentos × {price}' },
  totalPerMonth: '= {total} por mês',
  totalPerYear: '= {total} por ano',
  alreadyOnTeam: ' (já está no Team, gerenciado em Cobrança).',
  countingSeats: 'Contando assentos…',
  stripeNote:
    'Você vai configurar o pagamento no checkout seguro do Stripe. Cancele quando quiser pelo portal de cobrança.',
  askOwnerBefore: 'Peça a',
  askOwnerAfter: 'para escolher um plano, já que é quem cuida da cobrança.',
  workspaceOwnerFallback: 'o dono do workspace',
  openingStripe: 'Abrindo o Stripe…',
  continueCheckout: 'Continuar para o checkout',
  checkoutFailed: 'Não foi possível iniciar o checkout',
  receipts: 'Os recibos vão para {email}. Precisa de faturamento, SSO ou uma equipe maior?',
  talkToUs: 'Fale com a gente',
  receiptsEnd: '.',
  popular: 'Popular',
  current: 'Atual',
  letsTalk: 'Vamos conversar',
  perSeatMonth: '/ assento / mês',
  billedYearly: 'cobrado {price} por assento ao ano',
  contactUs: 'Fale conosco',

  /* move a canvas */
  moveTitle: 'Mover “{name}”',
  moveLede:
    'Um canvas em um workspace fica aberto para todos nele. Mova-o de volta para Pessoal e só você e as pessoas que você convidou mantêm o acesso.',
  destinationAria: 'Destino',
  personalOption: 'Pessoal (só você e convidados)',
  needsPlanSuffix: ' (precisa de um plano)',
  targetNoPlan: '{name} ainda não tem plano, então você vai precisar escolher um.',
  moving: 'Movendo…',
  moveCanvas: 'Mover canvas',
  moveFailed: 'Não foi possível mover o canvas',
}
