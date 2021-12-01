import Constants from '../../utils/Constants';
import Logging from '../../utils/Logging';
import MigrationTask from '../MigrationTask';
import { ServerAction } from '../../types/Server';
import Tenant from '../../types/Tenant';
import TenantStorage from '../../storage/mongodb/TenantStorage';
import Utils from '../../utils/Utils';
import global from '../../types/GlobalType';

const MODULE_NAME = 'UpdateEmailsToLowercaseTask';

export default class UpdateEmailsToLowercaseTask extends MigrationTask {
  public async migrate(): Promise<void> {
    const tenants = await TenantStorage.getTenants({}, Constants.DB_PARAMS_MAX_LIMIT);
    for (const tenant of tenants.result) {
      await this.migrateTenant(tenant);
    }
  }

  public async migrateTenant(tenant: Tenant): Promise<void> {
    // Get all the Users
    const updateResult = await global.database.getCollection<any>(tenant.id, 'users').updateMany(
      {},
      [{
        $set: {
          email: { $toLower: '$email' },
        }
      }]
    );
    if (updateResult.modifiedCount > 0) {
    // Log in the default tenant
      await Logging.logDebug({
        tenantID: Constants.DEFAULT_TENANT,
        module: MODULE_NAME, method: 'migrateTenant',
        action: ServerAction.MIGRATION,
        message: `${updateResult.modifiedCount} User(s) mail have been updated in Tenant ${Utils.buildTenantName(tenant)}`
      });
    }
  }

  public getVersion(): string {
    return '1.0';
  }

  public getName(): string {
    return 'UpdateEmailsToLowercaseTask';
  }

  public isAsynchronous(): boolean {
    return true;
  }
}