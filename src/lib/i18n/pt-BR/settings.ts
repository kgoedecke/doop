import type { Catalog } from '..'

export const settings: Catalog['settings'] = {
  sectionLabel: 'Configurações',
  backToCanvases: 'Voltar aos canvases',
  backToCanvas: 'Voltar ao canvas',
  canvases: 'Canvases',
  canvas: 'Canvas',

  agentTitle: 'Doop Agent',
  agentBlurb: 'Em qual conta de modelo o agente roda, em todos os canvases em que você trabalha.',
  keysTitle: 'Chaves de agente',
  keysBlurb: 'Credenciais bearer que deixam agentes sem interface desenharem em seu nome.',
  webhooksTitle: 'Webhooks',
  webhooksBlurb: 'Chamadas HTTP para os seus sistemas quando algo acontece em um canvas que você pode abrir.',
  accountTitle: 'Sua conta',
  accountTab: 'Conta',
  accountBlurb: 'Quem você é em cada canvas, e como voltar a entrar neste.',
  appearanceTitle: 'Aparência',
  appearanceBlurb:
    'Como o Doop aparece neste navegador: claro ou escuro, o idioma em que ele fala e como o editor do canvas organiza seus painéis.',

  agentCardDescription:
    'Escolha como o Doop Agent roda nos seus canvases: uma conta de modelo conectada ou o Claude CLI no seu computador. Os limites de uso e as cobranças do seu provedor se aplicam.',
  freeTasksLeftLabel: 'Tarefas gratuitas restantes do Doop Agent',
  meterGeminiCloud: 'Piloto do Gemini na nuvem selecionado. Conexão gerenciada pelo seu operador.',
  meterClaudeLocal: 'Claude CLI selecionado. Roda no seu computador conectado.',
  meterChatgpt: 'Rodando na sua assinatura do ChatGPT.',
  meterProviderKey: 'Rodando na sua chave da {provider}.',
  meterNoFreeTasks: 'Este servidor não oferece tarefas gratuitas. Conecte uma conta para usar o Doop Agent.',
  meterUsedUp: 'Suas tarefas gratuitas acabaram.',
  meterLeft: {
    one: '{left} de {count} tarefa gratuita restante.',
    other: '{left} de {count} tarefas gratuitas restantes.',
  },

  themeTitle: 'Tema',
  themeDescription:
    'Claro ou escuro, em todos os canvases e páginas deste navegador. Sistema segue o seu sistema operacional e muda sempre que ele mudar.',
  themeRow: 'Aparência',
  themeAria: 'Tema',
  themeSystem: 'Sistema',
  themeLight: 'Claro',
  themeDark: 'Escuro',
  themeFollowingSystem: 'Seguindo o sistema ({resolved} agora).',
  themeResolvedLight: 'claro',
  themeResolvedDark: 'escuro',
  themeSetByHand: 'Definido manualmente, então a configuração do sistema é ignorada.',

  languageTitle: 'Idioma',
  languageDescription:
    'O idioma em que as telas do Doop aparecem neste navegador. Enquanto você não escolher um, vale o padrão configurado neste servidor.',
  languageRow: 'Idioma',
  languageAria: 'Idioma',
  languagePicked: 'Escolhido neste navegador.',
  languageServerDefault: 'Padrão do servidor. Escolha um para mantê-lo neste navegador.',

  panelsTitle: 'Painéis do canvas',
  panelsDescription:
    'Como o editor do canvas organiza Camadas, o inspetor e Agentes neste navegador. Painéis flutuantes ficam sobre o canvas; painéis fixos encostam nas bordas da janela, com o canvas entre eles.',
  panelsRow: 'Layout',
  panelsAria: 'Painéis do canvas',
  panelsFloating: 'Flutuantes',
  panelsDocked: 'Fixos',
  panelsFloatingNote: 'Os painéis flutuam sobre o canvas.',
  panelsDockedNote: 'Os painéis estão fixos nas bordas.',
}
