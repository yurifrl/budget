import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'app.title': 'Administração do Budget',
  'nav.jobs': 'Jobs',
  'nav.users': 'Usuários',
  'nav.features': 'Recursos',
  'language.label': 'Idioma',
  'language.system': 'Sistema',
  'auth.signInTitle': 'É necessário entrar',
  'auth.signInBody':
    'Entre em <link>{url}</link> com uma conta de administrador e recarregue esta página. Entrar no app (por qualquer método: senha, Google ou Access) também funciona, pois o cookie de sessão é compartilhado.',
  'auth.notAdminTitle': 'Sem acesso de administrador',
  'auth.notAdminBody': 'Sua conta não é de administrador.',
  'banner.unreachable': 'Não foi possível acessar a API: {message}',
  'banner.schedulerDown': 'Agendador (Temporal) indisponível — as execuções ficam na fila: {reason}<b> · {count} na fila</b>',
  'banner.unknownReason': 'motivo desconhecido',
  'banner.schedulerUp': 'Agendador ativo · {count} na fila · instância <code>{instance}</code>',
  'role.user': 'usuário',
  'role.admin': 'administrador',
  'userStatus.active': 'ativo',
  'userStatus.disabled': 'desativado',
  'runStatus.queued': 'na fila',
  'runStatus.running': 'em execução',
  'runStatus.succeeded': 'concluída',
  'runStatus.failed': 'com falha',
  'runStatus.cancelled': 'cancelada',
  'logLevel.debug': 'debug',
  'logLevel.info': 'info',
  'logLevel.warn': 'aviso',
  'logLevel.error': 'erro',
};

export default m;
