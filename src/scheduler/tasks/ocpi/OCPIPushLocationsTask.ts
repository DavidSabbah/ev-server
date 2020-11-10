import { OCPIPushLocationsTaskConfig, TaskConfig } from '../../../types/TaskConfig';

import Constants from '../../../utils/Constants';
import LockingHelper from '../../../locking/LockingHelper';
import LockingManager from '../../../locking/LockingManager';
import Logging from '../../../utils/Logging';
import OCPIClientFactory from '../../../client/ocpi/OCPIClientFactory';
import OCPIEndpoint from '../../../types/ocpi/OCPIEndpoint';
import OCPIEndpointStorage from '../../../storage/mongodb/OCPIEndpointStorage';
import { OCPIRegistrationStatus } from '../../../types/ocpi/OCPIRegistrationStatus';
import { OCPIRole } from '../../../types/ocpi/OCPIRole';
import SchedulerTask from '../../SchedulerTask';
import { ServerAction } from '../../../types/Server';
import Tenant from '../../../types/Tenant';
import TenantComponents from '../../../types/TenantComponents';
import Utils from '../../../utils/Utils';

const MODULE_NAME = 'OCPIPushLocationsTask';

export default class OCPIPushLocationsTask extends SchedulerTask {

  async processTenant(tenant: Tenant, config: TaskConfig): Promise<void> {
    try {
      // Check if OCPI component is active
      if (Utils.isTenantComponentActive(tenant, TenantComponents.OCPI)) {
        // Get all available endpoints
        const ocpiEndpoints = await OCPIEndpointStorage.getOcpiEndpoints(tenant.id, { role: OCPIRole.CPO }, Constants.DB_PARAMS_MAX_LIMIT);
        for (const ocpiEndpoint of ocpiEndpoints.result) {
          await this.processOCPIEndpoint(tenant, ocpiEndpoint, config);
        }
      }
    } catch (error) {
      // Log error
      Logging.logActionExceptionMessage(tenant.id, ServerAction.OCPI_PUSH_LOCATIONS, error);
    }
  }

  private async processOCPIEndpoint(tenant: Tenant, ocpiEndpoint: OCPIEndpoint, config: OCPIPushLocationsTaskConfig): Promise<void> {
    // Get the lock
    const ocpiLock = await LockingHelper.createOCPIEndpointActionLock(tenant.id, ocpiEndpoint, 'patch-locations');
    if (ocpiLock) {
      try {
        // Check if OCPI endpoint is registered
        if (ocpiEndpoint.status !== OCPIRegistrationStatus.REGISTERED) {
          Logging.logDebug({
            tenantID: tenant.id,
            module: MODULE_NAME, method: 'processOCPIEndpoint',
            action: ServerAction.OCPI_PUSH_LOCATIONS,
            message: `The OCPI Endpoint ${ocpiEndpoint.name} is not registered. Skipping the ocpiendpoint.`
          });
          return;
        } else if (!ocpiEndpoint.backgroundPatchJob) {
          Logging.logDebug({
            tenantID: tenant.id,
            module: MODULE_NAME, method: 'processOCPIEndpoint',
            action: ServerAction.OCPI_PUSH_LOCATIONS,
            message: `The OCPI Endpoint ${ocpiEndpoint.name} is inactive.`
          });
          return;
        }
        Logging.logInfo({
          tenantID: tenant.id,
          module: MODULE_NAME, method: 'processOCPIEndpoint',
          action: ServerAction.OCPI_PUSH_LOCATIONS,
          message: `The push Locations process for endpoint ${ocpiEndpoint.name} is being processed`
        });
        // Build OCPI Client
        const ocpiClient = await OCPIClientFactory.getCpoOcpiClient(tenant, ocpiEndpoint);
        // Send EVSE statuses
        const sendResult = await ocpiClient.sendEVSEStatuses(!Utils.isUndefined(config.processAllEVSEs) ? config.processAllEVSEs : false);
        Logging.logInfo({
          tenantID: tenant.id,
          module: MODULE_NAME, method: 'processOCPIEndpoint',
          action: ServerAction.OCPI_PUSH_LOCATIONS,
          message: `The push Locations process for endpoint ${ocpiEndpoint.name} is completed (Success: ${sendResult.success}/Failure: ${sendResult.failure})`
        });
      } catch (error) {
        // Log error
        Logging.logActionExceptionMessage(tenant.id, ServerAction.OCPI_PUSH_LOCATIONS, error);
      } finally {
        // Release the lock
        await LockingManager.release(ocpiLock);
      }
    }
  }
}

