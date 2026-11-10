import type { Catalog } from '..'

export const settings: Catalog['settings'] = {
  sectionLabel: 'Configurações',
  backToCanvases: 'Voltar aos canvases',
  backToCanvas: 'Voltar ao canvas',
  canvases: 'Canvases',
  canvas: 'Canvas',

  generalTitle: 'Geral',
  generalBlurb: 'Deixe o Doop do jeito que você gosta neste navegador.',
  homeDashboardTitle: 'Painel inicial',
  homeDashboardDescription: 'Escolha o que aparece no seu painel inicial neste navegador.',
  showPromptBox: 'Mostrar a caixa de prompt',
  showPromptBoxHint: 'Comece um design a partir de um prompt no painel inicial.',
  agentTitle: 'Doop Agent',
  agentBlurb: 'Suas conexões, e a que o agente usa quando ninguém escolhe: comentários, @menções e automações.',
  fontsTitle: 'Fontes',
  fontsBlurb: 'Suas próprias fontes, para criar nos seus canvases pessoais.',
  keysTitle: 'Chaves de agente',
  keysBlurb: 'Credenciais bearer que deixam agentes sem interface desenharem em seu nome.',
  webhooksTitle: 'Webhooks',
  webhooksBlurb: 'Chamadas HTTP para os seus sistemas quando algo acontece em um canvas que você pode abrir.',
  accountTitle: 'Sua conta',
  accountTab: 'Conta',
  accountBlurb: 'Quem você é em cada canvas — e como voltar a entrar neste.',
  appearanceTitle: 'Aparência',
  appearanceBlurb:
    'Como o Doop aparece neste navegador: claro ou escuro e como o editor do canvas organiza seus painéis.',

  freeTasksLeftLabel: 'Tarefas gratuitas restantes do Doop Agent',
  meterGeminiCloud: 'Piloto do Gemini na nuvem selecionado — conexão gerenciada pelo seu operador.',
  meterNoFreeTasks: 'Este servidor não oferece tarefas gratuitas — conecte uma conta para usar o Doop Agent.',
  meterUsedUp: 'Suas tarefas gratuitas acabaram.',
  meterLeft: {
    one: '{left} de {count} tarefa gratuita restante.',
    other: '{left} de {count} tarefas gratuitas restantes.',
  },

  imageDescriptionsTitle: 'Descrições de imagens',
  imageDescriptionsDescription:
    'Uma descrição curta ajuda os agentes a entender imagens enviadas. Minha conta usa sua conta para seus envios, depois uma conta elegível do dono do canvas e, por último, este servidor. Também permite que sua conta cubra envios nos seus canvases quando quem enviou não tem um modelo elegível. Este servidor usa apenas as credenciais do servidor para seus envios e exclui sua conta das alternativas. Desligado impede descrições dos seus envios e dos seus canvases. As cobranças do seu provedor se aplicam.',
  imageDescriptionsAria: 'Descrições de imagens',
  imageDescriptionsOff: 'Desligado',
  imageDescriptionsAccount: 'Minha conta',
  imageDescriptionsServer: 'Este servidor',
  imageDescriptionsRunsOn: 'Modelo disponível: {label}. Novas tentativas mantêm o pagador original.',
  imageDescriptionsReasonOff: 'Seus envios e as imagens dos seus canvases não são descritos.',
  imageDescriptionsReasonTextOnly:
    'Sua conta não tem um modelo de visão elegível e este servidor não tem um modelo. Uma conta elegível do dono de outro canvas pode descrever seus envios; caso contrário, ficam sem descrição.',
  imageDescriptionsReasonNoModel:
    'Nenhum modelo para envios está disponível aqui. No modo Minha conta, uma conta elegível do dono de outro canvas ainda pode descrever seus envios.',

  themeTitle: 'Tema',
  themeDescription:
    'Claro ou escuro, em todos os canvases e páginas deste navegador. Sistema segue o seu sistema operacional e muda sempre que ele mudar.',
  themeRow: 'Aparência',
  themeAria: 'Tema',
  themeSystem: 'Sistema',
  themeLight: 'Claro',
  themeDark: 'Escuro',
  themeFollowingSystem: 'Seguindo o sistema — {resolved} agora.',
  themeResolvedLight: 'claro',
  themeResolvedDark: 'escuro',
  themeSetByHand: 'Definido manualmente — a configuração do sistema é ignorada.',

  languageTitle: 'Idioma',
  languageDescription:
    'O idioma em que as telas do Doop aparecem neste navegador. Enquanto você não escolher um, vale o padrão configurado neste servidor.',
  languageRow: 'Idioma',
  languageAria: 'Idioma',
  languagePicked: 'Escolhido neste navegador.',
  languageServerDefault: 'Padrão do servidor — escolha um para mantê-lo neste navegador.',

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
