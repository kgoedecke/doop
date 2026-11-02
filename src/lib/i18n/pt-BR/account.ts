import type { Catalog } from '..'

export const account: Catalog['account'] = {
  nameSaveFailed: 'Não foi possível salvar esse nome',
  nameSaved: 'Salvo — os agentes passam a usá-lo em até um minuto',
  passwordChangeFailed: 'Não foi possível alterar essa senha',
  passwordUpdated: 'Senha atualizada — todas as outras sessões foram encerradas',
  notifySaveFailed: 'Não foi possível salvar — tente de novo',
  verificationSendFailed: 'Não foi possível enviar esse e-mail',
  verificationSent: 'E-mail de verificação enviado',

  profileTitle: 'Perfil',
  profileDescription:
    'Seu nome é a identidade mostrada nos cursores, no feed de atividades e em tudo o que você deixa para um agente. Os agentes veem a mudança em até um minuto.',
  nameRow: 'Nome',
  saving: 'Salvando…',
  displayNameAria: 'Nome de exibição',
  nameUnsaved: 'Alterado — ainda não salvo',
  emailRow: 'E-mail',
  emailNotChangeable: 'Endereço de acesso — ainda não pode ser alterado',
  resendVerification: 'Reenviar verificação',
  verified: 'verificado',
  unverified: 'não verificado',

  notificationsTitle: 'Notificações',
  notificationsDescription:
    'E-mails sobre o que acontece nos seus canvases enquanto você não está olhando para eles. Seus próprios comentários nunca geram um.',
  commentEmailsRow: 'E-mails de comentários',
  commentEmailsAria: 'Enviar e-mail sobre novos comentários e respostas',
  commentEmailsLabel:
    'Novos comentários e respostas em canvases que são seus, para os quais você foi convidado ou em que você escreveu — reunidos em um e-mail por canvas a cada poucos minutos.',
  emailNotConfigured: 'Este doop não tem e-mail configurado (SMTP_HOST), então nada é enviado de qualquer forma.',

  passwordTitle: 'Senha',
  passwordDescription:
    'Alterá-la encerra a sessão em todos os outros navegadores e dispositivos — este continua conectado.',
  currentPassword: 'Senha atual',
  newPassword: 'Nova senha',
  updatingPassword: 'Atualizando…',
  updatePassword: 'Atualizar senha',
  passwordMinLength: 'Pelo menos 8 caracteres',
}
