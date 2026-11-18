import app, { operations } from './index';
import { describeOperationCatalog } from '../core/operation-catalog-test';

describeOperationCatalog('rates', operations, app, '/rates');
