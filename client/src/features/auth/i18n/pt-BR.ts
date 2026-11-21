import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'failure.generic': 'Algo deu errado. Tente novamente.',
  'failure.network': 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
  'failure.tooManyAttempts': 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
  'failure.tooManyAttemptsWait': 'Muitas tentativas. Tente novamente em {wait}.',
  'failure.wrongPassword': 'A senha atual não está correta.',
  'failure.wrongCredentials': 'E-mail ou senha incorretos.',
  'failure.tempExpired': 'Sua senha temporária expirou. Peça uma nova ao administrador.',
  'failure.changeLinkExpired':
    'O tempo para escolher uma nova senha acabou. Entre novamente com sua senha temporária. Se ela tiver expirado, peça uma nova ao administrador.',
  'failure.forbidden':
    'Sua senha não pode ser alterada a partir deste tipo de sessão. Saia, entre com seu e-mail e sua senha e tente novamente.',
  'failure.originNotAllowed': 'Não é permitido entrar a partir deste endereço.',
  'failure.enterCredentials': 'Informe seu e-mail e sua senha.',
  'failure.checkForm': 'Confira o formulário e tente novamente.',
  'form.passwordMismatch': 'As duas senhas não coincidem.',
  'form.enterCurrent': 'Informe sua senha atual.',

  'wait.seconds': { one: '{count} segundo', other: '{count} segundos' },
  'wait.minutes': { one: '{count} minuto', other: '{count} minutos' },
  'wait.hours': { one: '{count} hora', other: '{count} horas' },

  'landing.headline': 'Um orçamento para a casa toda.',
  'landing.body':
    'Planeje cada mês, mantenha suas contas em dia e veja para onde vai o dinheiro, junto com as pessoas com quem você compartilha um orçamento.',
  'landing.footnote': 'Não existe cadastro. Use o login que você já tem.',
  'landing.unreachableHeadline': 'Não foi possível acessar a API',
  'landing.unreachableBody': 'Sem resposta de {url}. Tentando novamente de forma automática.',
  'landing.retry': 'Tentar agora',
  'landing.orEmail': 'ou entre com e-mail',
  'landing.changeHeadline': 'Escolha uma nova senha.',
  'landing.changeBody':
    'Você entrou com uma senha temporária. Escolha a sua para continuar. Use pelo menos {min} caracteres; algumas palavras comuns juntas funcionam bem.',

  'button.signIn': 'Entrar',
  'button.signInGoogle': 'Entrar com o Google',
  'notice.accessRetry': 'A entrada automática com o Cloudflare Access não foi concluída. Tente novamente.',
  'notice.cancelled': 'Entrada cancelada.',
  'notice.failed': 'Não foi possível entrar. Tente novamente.',

  'form.email': 'E-mail',
  'form.password': 'Senha',
  'form.signIn': 'Entrar com e-mail',
  'form.newPassword': 'Nova senha',
  'form.repeatPassword': 'Repita a nova senha',
  'form.setPassword': 'Definir senha e entrar',
  'form.backToSignIn': 'Voltar ao login',
};
export default m;
