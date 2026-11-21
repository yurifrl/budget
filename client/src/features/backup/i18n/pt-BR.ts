import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'screen.needBudget': 'Ative um orçamento para exportar ou restaurar.',

  'export.title': 'Exportar',
  'export.hint':
    'Salva o orçamento inteiro — plano de categorias e registro de transações — em um arquivo zip com duas tabelas TSV, que você pode compartilhar a partir deste dispositivo.',
  'export.button': 'Exportar backup',
  'export.preparing': 'Preparando…',
  'export.failed': 'Não foi possível exportar o backup.',

  'import.title': 'Importar',
  'import.ownerOnly': 'Só o dono deste orçamento pode restaurar um backup nele.',
  'import.hint':
    'Restaura tabelas de backup neste orçamento. Escolha o arquivo do Plano, o do Registro ou os dois e depois marque o que restaurar: o plano (categorias, atribuições) e/ou o registro (contas, transações). Tudo o que você restaurar substitui o que está no orçamento agora.',
  'import.choosePlan': 'Escolher arquivo do Plano…',
  'import.chooseRegister': 'Escolher arquivo do Registro…',
  'import.chooseAgain': 'Escolher de novo…',
  'import.reading': 'Lendo…',
  'import.noFile': 'Nenhum arquivo escolhido',
  'import.wrongTable': '{file}: não é a tabela do {table} — esperado um arquivo cujo nome termine em “{suffix}”',
  'import.unreadable': 'Este não é um backup legível.',
  'import.readFailed': 'Não foi possível ler o arquivo.',
  'import.restoreFailed': 'Não foi possível restaurar o backup.',

  'restored.summary': 'Restaurado: {counts}.',
  'restored.nothing': 'Nada foi restaurado.',
  'restored.uncategorized': {
    one: '{count} transação ficou sem categoria porque nenhuma correspondia.',
    other: '{count} transações ficaram sem categoria porque nenhuma correspondia.',
  },

  'section.plan': 'Plano',
  'section.register': 'Registro',
  'scope.title': 'Este backup contém',
  'scope.missing': 'Não está nos arquivos escolhidos',
  'scope.chooseNone': 'Escolha o que restaurar',
  'scope.restore': 'Restaurar seleção…',
  'scope.sectionCounts': '{section}: {counts}',

  'count.group': { one: '{count} grupo', other: '{count} grupos' },
  'count.category': { one: '{count} categoria', other: '{count} categorias' },
  'count.account': { one: '{count} conta', other: '{count} contas' },
  'count.transaction': { one: '{count} transação', other: '{count} transações' },
  'count.assignment': { one: '{count} atribuição', other: '{count} atribuições' },

  'confirm.title': 'Restaurar este backup?',
  'confirm.replaceAll':
    'Isto substitui tudo o que há em “{name}” (categorias, contas, favorecidos, transações e atribuições) por:',
  'confirm.replacePlan': 'Isto substitui as categorias, os grupos e as atribuições de “{name}” por:',
  'confirm.replaceRegister': 'Isto substitui as contas, os favorecidos e as transações de “{name}” por:',
  'confirm.noteWithPlan':
    'Suas contas e transações atuais permanecem. As categorias delas são vinculadas de novo às categorias restauradas, pelo grupo e pelo nome; transações cuja categoria não está no backup ficam sem categoria.',
  'confirm.noteWithRegister':
    'Suas categorias e atribuições atuais permanecem. As categorias das transações são associadas a elas pelo grupo e pelo nome; transações cuja categoria não for encontrada ficam sem categoria.',
  'confirm.unmatched': {
    one: '{count} transação cita uma categoria que este orçamento não tem e ficará sem categoria.',
    other: '{count} transações citam uma categoria que este orçamento não tem e ficarão sem categoria.',
  },
  'confirm.replace': 'Substituir',
  'confirm.restoring': 'Restaurando…',

  'transfer.notUtf8': '{file}: não é UTF-8 válido',
  'transfer.notZip': '{file}: não é um arquivo zip legível',
  'transfer.noTable': 'é necessário um arquivo Plan.tsv ou Register.tsv',
  'transfer.needCategories': 'Register.tsv sozinho precisa das categorias do orçamento para fazer a correspondência',
  'transfer.planHeader': 'Plan.tsv: linha de cabeçalho inesperada',
  'transfer.registerHeader': 'Register.tsv: linha de cabeçalho inesperada',
  'transfer.badMonth': 'Plan.tsv: célula de mês ilegível {cell}',
  'transfer.noCategory': 'Plan.tsv: linha sem categoria {row}',
  'transfer.badDate': 'Register.tsv: célula de data ilegível {cell}',
  'transfer.unknownCleared': 'Register.tsv: célula Cleared desconhecida {cell} -> pendente',
  'transfer.unknownCategories': 'Register.tsv: categorias desconhecidas: {list}',
  'transfer.missingCategories': 'Register.tsv: categorias que não estão neste orçamento (as linhas ficam sem categoria): {list}',
  'transfer.unknownAccount': 'Register.tsv: o favorecido da transferência cita uma conta desconhecida {account}',
  'transfer.unpairedTransfer': 'Register.tsv: transferência sem par {payee}',
  'transfer.notMember': '{file}: {email} não é membro deste orçamento -> Compartilhado',
};
export default m;
