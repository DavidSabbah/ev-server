import axios, { AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';
import _ from 'lodash';
import moment from 'moment';
import BackendError from '../../exception/BackendError';
import NotificationHandler from '../../notification/NotificationHandler';
import OCPIMapping from '../../server/ocpi/ocpi-services-impl/ocpi-2.1.1/OCPIMapping';
import OCPITokensService from '../../server/ocpi/ocpi-services-impl/ocpi-2.1.1/OCPITokensService';
import OCPIUtils from '../../server/ocpi/OCPIUtils';
import OCPIEndpointStorage from '../../storage/mongodb/OCPIEndpointStorage';
import OCPPStorage from '../../storage/mongodb/OCPPStorage';
import SiteAreaStorage from '../../storage/mongodb/SiteAreaStorage';
import SiteStorage from '../../storage/mongodb/SiteStorage';
import TenantStorage from '../../storage/mongodb/TenantStorage';
import TransactionStorage from '../../storage/mongodb/TransactionStorage';
import ChargingStation, { Connector } from '../../types/ChargingStation';
import { OCPIAllowed, OCPIAuthorizationInfo } from '../../types/ocpi/OCPIAuthorizationInfo';
import { OCPICdr } from '../../types/ocpi/OCPICdr';
import OCPIEndpoint from '../../types/ocpi/OCPIEndpoint';
import { OCPIEvseStatus } from '../../types/ocpi/OCPIEvse';
import { OCPIJobResult } from '../../types/ocpi/OCPIJobResult';
import { OCPILocation, OCPILocationReference } from '../../types/ocpi/OCPILocation';
import { OCPIRole } from '../../types/ocpi/OCPIRole';
import { OCPIAuthMethod, OCPISession, OCPISessionStatus } from '../../types/ocpi/OCPISession';
import { OCPIToken } from '../../types/ocpi/OCPIToken';
import { ServerAction } from '../../types/Server';
import { OcpiSetting } from '../../types/Setting';
import Site from '../../types/Site';
import Tenant from '../../types/Tenant';
import Transaction from '../../types/Transaction';
import Constants from '../../utils/Constants';
import Logging from '../../utils/Logging';
import Utils from '../../utils/Utils';
import OCPIClient from './OCPIClient';

const MODULE_NAME = 'CpoOCPIClient';

export default class CpoOCPIClient extends OCPIClient {
  constructor(tenant: Tenant, settings: OcpiSetting, ocpiEndpoint: OCPIEndpoint) {
    super(tenant, settings, ocpiEndpoint, OCPIRole.CPO);
    if (ocpiEndpoint.role !== OCPIRole.CPO) {
      throw new BackendError({
        message: `CpoOcpiClient requires Ocpi Endpoint with role ${OCPIRole.CPO}`,
        module: MODULE_NAME, method: 'constructor',
      });
    }
  }

  /**
   * Pull Tokens
   */
  async pullTokens(partial = true): Promise<OCPIJobResult> {
    // Result
    const sendResult = {
      success: 0,
      failure: 0,
      total: 0,
      logs: []
    };
    // Get tokens endpoint url
    let tokensUrl = this.getEndpointUrl('tokens', ServerAction.OCPI_PULL_TOKENS);
    if (partial) {
      const momentFrom = moment().utc().subtract(1, 'days').startOf('day');
      tokensUrl = `${tokensUrl}?date_from=${momentFrom.format()}&limit=100`;
    } else {
      tokensUrl = `${tokensUrl}?limit=100`;
    }
    let nextResult = true;
    while (nextResult) {
      // Log
      Logging.logDebug({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_PULL_TOKENS,
        message: `Pull Tokens at ${tokensUrl}`,
        module: MODULE_NAME, method: 'pullTokens'
      });
      // Call IOP
      let response: AxiosResponse;
      try {
        response = await this.axiosInstance.get(tokensUrl,
          {
            headers: {
              Authorization: `Token ${this.ocpiEndpoint.token}`
            },
            timeout: Constants.AXIOS_TIMEOUT
          });
      } catch (error) {
        // Handle errors
        Utils.handleAxiosError(error, tokensUrl, ServerAction.OCPI_PULL_TOKENS, MODULE_NAME, 'pullTokens');
      }
      // Check response
      if (response.status !== 200 || !response.data) {
        throw new BackendError({
          action: ServerAction.OCPI_PULL_TOKENS,
          message: `Invalid response code ${response.status} from Pull tokens`,
          module: MODULE_NAME, method: 'pullTokens',
        });
      }
      if (!response.data.data) {
        throw new BackendError({
          action: ServerAction.OCPI_PULL_TOKENS,
          message: 'Invalid response from Pull tokens',
          module: MODULE_NAME, method: 'pullTokens',
          detailedMessages: { data: response.data }
        });
      }
      Logging.logDebug({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_PULL_TOKENS,
        message: `${response.data.data.length.toString()} Tokens retrieved from ${tokensUrl}`,
        module: MODULE_NAME, method: 'pullTokens'
      });
      for (const token of response.data.data) {
        try {
          await OCPITokensService.updateToken(this.tenant.id, this.ocpiEndpoint, token);
          sendResult.success++;
          sendResult.logs.push(
            `Token ${token.uid} successfully updated`
          );
        } catch (error) {
          sendResult.failure++;
          sendResult.logs.push(
            `Failure updating token:${token.uid}:${error.message}`
          );
        }
      }
      const nextUrl = OCPIUtils.getNextUrl(response.headers.link);
      if (nextUrl && nextUrl.length > 0 && nextUrl !== tokensUrl) {
        tokensUrl = nextUrl;
      } else {
        nextResult = false;
      }
    }
    return sendResult;
  }

  async authorizeToken(token: OCPIToken, chargingStation: ChargingStation): Promise<string> {
    if (chargingStation.remoteAuthorizations && chargingStation.remoteAuthorizations.length > 0) {
      for (const remoteAuthorization of chargingStation.remoteAuthorizations) {
        if (remoteAuthorization.tagId === token.uid && OCPIUtils.isAuthorizationValid(remoteAuthorization.timestamp)) {
          Logging.logDebug({
            tenantID: this.tenant.id,
            action: ServerAction.OCPI_AUTHORIZE_TOKEN,
            message: `Valid Remote Authorization found for tag ${token.uid}`,
            module: MODULE_NAME, method: 'authorizeToken',
            detailedMessages: { response: remoteAuthorization }
          });
          return remoteAuthorization.id;
        }
      }
    }
    // Get tokens endpoint url
    const tokensUrl = `${this.getEndpointUrl('tokens', ServerAction.OCPI_AUTHORIZE_TOKEN)}/${token.uid}/authorize`;
    let siteID;
    if (!chargingStation.siteArea || !chargingStation.siteArea.siteID) {
      const siteArea = await SiteAreaStorage.getSiteArea(this.tenant.id, chargingStation.siteAreaID);
      siteID = siteArea ? siteArea.siteID : null;
    } else {
      siteID = chargingStation.siteArea.siteID;
    }
    // Build payload
    const payload: OCPILocationReference =
    {
      'location_id': siteID,
      'evse_uids': [OCPIUtils.buildEvseUID(chargingStation)]
    };
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_AUTHORIZE_TOKEN,
      message: `Post authorize at ${tokensUrl}`,
      module: MODULE_NAME, method: 'authorizeToken',
      detailedMessages: { payload }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.post(tokensUrl, payload,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, tokensUrl, ServerAction.OCPI_AUTHORIZE_TOKEN, MODULE_NAME, 'authorizeToken');
    }
    if (response.status !== 200 || !response.data) {
      throw new BackendError({
        action: ServerAction.OCPI_AUTHORIZE_TOKEN,
        message: `Post authorize failed with status ${response.status}`,
        module: MODULE_NAME, method: 'authorizeToken',
        detailedMessages: { payload: response.data }
      });
    }
    if (!response.data.data) {
      throw new BackendError({
        action: ServerAction.OCPI_AUTHORIZE_TOKEN,
        message: 'Invalid response from Post Authorize',
        module: MODULE_NAME, method: 'authorizeToken',
        detailedMessages: { data: response.data }
      });
    }
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_AUTHORIZE_TOKEN,
      message: `Authorization response retrieved from ${tokensUrl}`,
      module: MODULE_NAME, method: 'authorizeToken',
      detailedMessages: { response: response.data }
    });
    const authorizationInfo = response.data.data as OCPIAuthorizationInfo;
    if (authorizationInfo.allowed !== OCPIAllowed.ALLOWED) {
      throw new BackendError({
        action: ServerAction.OCPI_AUTHORIZE_TOKEN,
        message: 'Authorization rejected',
        module: MODULE_NAME, method: 'authorizeToken',
        detailedMessages: { authorizationInfo }
      });
    }
    if (!authorizationInfo.authorization_id) {
      throw new BackendError({
        action: ServerAction.OCPI_AUTHORIZE_TOKEN,
        message: 'Authorization allowed without \'authorization_id\'',
        module: MODULE_NAME, method: 'authorizeToken',
        detailedMessages: { authorizationInfo }
      });
    }
    return authorizationInfo.authorization_id;
  }

  async startSession(ocpiToken: OCPIToken, chargingStation: ChargingStation, transaction: Transaction, authorizationId: string): Promise<void> {
    // Get tokens endpoint url
    const sessionsUrl = `${this.getEndpointUrl('sessions', ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalCountryCode(ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalPartyID(ServerAction.OCPI_PUSH_SESSIONS)}/${authorizationId}`;
    let siteID;
    if (!chargingStation.siteArea || !chargingStation.siteArea.siteID) {
      const siteArea = await SiteAreaStorage.getSiteArea(this.tenant.id, chargingStation.siteAreaID);
      siteID = siteArea ? siteArea.siteID : null;
    } else {
      siteID = chargingStation.siteArea.siteID;
    }
    const site: Site = await SiteStorage.getSite(this.tenant.id, siteID);
    const ocpiLocation: OCPILocation = OCPIMapping.convertChargingStationToOCPILocation(
      site, chargingStation, transaction.connectorId, this.getLocalCountryCode(ServerAction.OCPI_PUSH_SESSIONS), this.getLocalPartyID(ServerAction.OCPI_PUSH_SESSIONS));
    // Build payload
    const ocpiSession: OCPISession =
    {
      'id': authorizationId,
      'start_datetime': transaction.timestamp,
      'kwh': 0,
      'total_cost': transaction.currentCumulatedPrice,
      'auth_method': OCPIAuthMethod.AUTH_REQUEST,
      'auth_id': ocpiToken.auth_id,
      'location': ocpiLocation,
      'currency': transaction.priceUnit,
      'status': OCPISessionStatus.PENDING,
      'authorization_id': authorizationId,
      'last_updated': transaction.timestamp
    };
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Start session at ${sessionsUrl}`,
      module: MODULE_NAME, method: 'startSession',
      detailedMessages: { payload: ocpiSession }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.put(sessionsUrl, ocpiSession,
        {
          headers: {
            'Authorization': `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        }
      );
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, sessionsUrl, ServerAction.OCPI_PUSH_SESSIONS, MODULE_NAME, 'startSession');
    }
    transaction.ocpiData = {
      session: ocpiSession
    };
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Start session response received from ${sessionsUrl}`,
      module: MODULE_NAME, method: 'startSession',
      detailedMessages: { response: response.data }
    });
  }

  async updateSession(transaction: Transaction): Promise<void> {
    if (!transaction.ocpiData || !transaction.ocpiData.session) {
      throw new BackendError({
        source: transaction.chargeBoxID,
        action: ServerAction.OCPI_PUSH_SESSIONS,
        message: 'OCPI Session not started',
        module: MODULE_NAME, method: 'updateSession',
      });
    }
    // Get tokens endpoint url
    const sessionsUrl = `${this.getEndpointUrl('sessions', ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalCountryCode(ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalPartyID(ServerAction.OCPI_PUSH_SESSIONS)}/${transaction.ocpiData.session.id}`;
    transaction.ocpiData.session.kwh = transaction.currentTotalConsumptionWh / 1000;
    transaction.ocpiData.session.last_updated = transaction.currentTimestamp;
    transaction.ocpiData.session.total_cost = transaction.currentCumulatedPrice;
    transaction.ocpiData.session.currency = transaction.priceUnit;
    transaction.ocpiData.session.status = OCPISessionStatus.ACTIVE;
    transaction.ocpiData.session.charging_periods = await OCPIMapping.buildChargingPeriods(this.tenant.id, transaction);

    const patchBody: Partial<OCPISession> = {
      kwh: transaction.ocpiData.session.kwh,
      last_updated: transaction.ocpiData.session.last_updated,
      total_cost: transaction.ocpiData.session.total_cost,
      currency: transaction.ocpiData.session.currency,
      status: transaction.ocpiData.session.status,
      charging_periods: transaction.ocpiData.session.charging_periods
    };
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Patch session at ${sessionsUrl}`,
      module: MODULE_NAME, method: 'updateSession',
      detailedMessages: { payload: patchBody }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.patch(sessionsUrl, patchBody,
        {
          headers: {
            'Authorization': `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, sessionsUrl, ServerAction.OCPI_PUSH_SESSIONS, MODULE_NAME, 'updateSession');
    }
    if (response.status !== 200 || !response.data) {
      throw new BackendError({
        action: ServerAction.OCPI_PUSH_SESSIONS,
        message: `Patch Session failed with status ${response.status}`,
        module: MODULE_NAME, method: 'updateSession',
        detailedMessages: { payload: response.data }
      });
    }
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Patch session response received from ${sessionsUrl}`,
      module: MODULE_NAME, method: 'updateSession',
      detailedMessages: { response: response.data }
    });
  }

  async stopSession(transaction: Transaction): Promise<void> {
    if (!transaction.ocpiData || !transaction.ocpiData.session) {
      throw new BackendError({
        source: transaction.chargeBoxID,
        action: ServerAction.OCPI_PUSH_SESSIONS,
        message: 'OCPI Session not started',
        module: MODULE_NAME, method: 'stopSession',
      });
    }
    if (!transaction.stop) {
      throw new BackendError({
        source: transaction.chargeBoxID,
        action: ServerAction.OCPI_PUSH_SESSIONS,
        message: 'Transaction not stopped',
        module: MODULE_NAME, method: 'stopSession',
      });
    }
    // Get tokens endpoint url
    const tokensUrl = `${this.getEndpointUrl('sessions', ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalCountryCode(ServerAction.OCPI_PUSH_SESSIONS)}/${this.getLocalPartyID(ServerAction.OCPI_PUSH_SESSIONS)}/${transaction.ocpiData.session.id}`;
    transaction.ocpiData.session.kwh = transaction.stop.totalConsumptionWh / 1000;
    transaction.ocpiData.session.total_cost = transaction.stop.roundedPrice;
    transaction.ocpiData.session.end_datetime = transaction.stop.timestamp;
    transaction.ocpiData.session.last_updated = transaction.stop.timestamp;
    transaction.ocpiData.session.status = OCPISessionStatus.COMPLETED;
    transaction.ocpiData.session.charging_periods = await OCPIMapping.buildChargingPeriods(this.tenant.id, transaction);
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Stop session at ${tokensUrl}`,
      module: MODULE_NAME, method: 'stopSession',
      detailedMessages: { payload: transaction.ocpiData.session }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.put(tokensUrl, transaction.ocpiData.session,
        {
          headers: {
            'Authorization': `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, tokensUrl, ServerAction.OCPI_PUSH_SESSIONS, MODULE_NAME, 'stopSession');
    }
    if (response.status !== 200 || !response.data) {
      throw new BackendError({
        action: ServerAction.OCPI_PUSH_SESSIONS,
        message: `Stop Session failed with status ${response.status}`,
        module: MODULE_NAME, method: 'stopSession',
        detailedMessages: { payload: response.data }
      });
    }
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_SESSIONS,
      message: `Push session response retrieved from ${tokensUrl}`,
      module: MODULE_NAME, method: 'stopSession',
      detailedMessages: { response: response.data }
    });
  }

  async postCdr(transaction: Transaction): Promise<void> {
    if (!transaction.ocpiData || !transaction.ocpiData.session) {
      throw new BackendError({
        source: transaction.chargeBoxID,
        action: ServerAction.OCPI_PUSH_CDRS,
        message: 'Session not started',
        module: MODULE_NAME, method: 'postCdr',
      });
    }
    if (!transaction.stop) {
      throw new BackendError({
        source: transaction.chargeBoxID,
        action: ServerAction.OCPI_PUSH_CDRS,
        message: 'Transaction not stopped',
        module: MODULE_NAME, method: 'postCdr',
      });
    }
    // Get tokens endpoint url
    const cdrsUrl = this.getEndpointUrl('cdrs', ServerAction.OCPI_PUSH_CDRS);
    transaction.ocpiData.cdr = {
      id: transaction.ocpiData.session.id,
      start_date_time: transaction.timestamp,
      stop_date_time: transaction.stop.timestamp,
      total_parking_time: transaction.stop.totalInactivitySecs,
      total_time: transaction.stop.totalDurationSecs / 3600, // In hours
      total_energy: transaction.stop.totalConsumptionWh / 1000,
      total_cost: transaction.stop.roundedPrice > 0 ? transaction.stop.roundedPrice : 0,
      currency: transaction.priceUnit ? transaction.priceUnit : '',
      auth_id: transaction.ocpiData.session.auth_id,
      authorization_id: transaction.ocpiData.session.authorization_id,
      auth_method: transaction.ocpiData.session.auth_method,
      location: transaction.ocpiData.session.location,
      charging_periods: await OCPIMapping.buildChargingPeriods(this.tenant.id, transaction),
      last_updated: transaction.stop.timestamp
    };
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_CDRS,
      message: `Post cdr at ${cdrsUrl}`,
      module: MODULE_NAME, method: 'stopSession',
      detailedMessages: { payload: transaction.ocpiData.cdr }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.post(cdrsUrl, transaction.ocpiData.cdr,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, cdrsUrl, ServerAction.OCPI_PUSH_CDRS, MODULE_NAME, 'stopSession');
    }
    if (response.status !== 200 || !response.data) {
      throw new BackendError({
        action: ServerAction.OCPI_PUSH_CDRS,
        message: `Post cdr failed with status ${response.status}`,
        module: MODULE_NAME, method: 'postCdr',
        detailedMessages: { payload: response.data }
      });
    }
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PUSH_CDRS,
      message: `Push cdr response retrieved from ${cdrsUrl}`,
      module: MODULE_NAME, method: 'postCdr',
      detailedMessages: { response: response.data }
    });
  }

  async removeChargingStation(chargingStation: ChargingStation): Promise<void> {
    if (!chargingStation.siteAreaID && !chargingStation.siteArea) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Charging Station must be associated to a site area',
        module: MODULE_NAME, method: 'removeChargingStation',
      });
    }
    if (!chargingStation.issuer) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Only charging Station issued locally can be exposed to IOP',
        module: MODULE_NAME, method: 'removeChargingStation',
      });
    }
    let siteID;
    if (!chargingStation.siteArea || !chargingStation.siteArea.siteID) {
      const siteArea = await SiteAreaStorage.getSiteArea(this.tenant.id, chargingStation.siteAreaID);
      siteID = siteArea ? siteArea.siteID : null;
    } else {
      siteID = chargingStation.siteArea.siteID;
    }
    for (const connector of chargingStation.connectors) {
      await this.patchEVSEStatus(siteID, OCPIUtils.buildEvseUID(chargingStation, connector), OCPIEvseStatus.REMOVED);
    }
  }

  async patchChargingStationStatus(chargingStation: ChargingStation, connector: Connector): Promise<void> {
    if (!chargingStation.siteAreaID && !chargingStation.siteArea) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Charging Station must be associated to a site area',
        module: MODULE_NAME, method: 'patchChargingStationStatus',
      });
    }
    if (!chargingStation.issuer) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Only charging Station issued locally can be exposed to IOP',
        module: MODULE_NAME, method: 'patchChargingStationStatus',
      });
    }
    if (!chargingStation.public) {
      throw new BackendError({
        source: chargingStation.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Private charging Station cannot be exposed to IOP',
        module: MODULE_NAME, method: 'patchChargingStationStatus',
      });
    }
    let siteID;
    if (!chargingStation.siteArea || !chargingStation.siteArea.siteID) {
      const siteArea = await SiteAreaStorage.getSiteArea(this.tenant.id, chargingStation.siteAreaID);
      siteID = siteArea ? siteArea.siteID : null;
    } else {
      siteID = chargingStation.siteArea.siteID;
    }
    await this.patchEVSEStatus(siteID, OCPIUtils.buildEvseUID(chargingStation, connector), OCPIMapping.convertStatus2OCPIStatus(connector.status));
  }

  /**
   * PATCH EVSE Status
   */
  async patchEVSEStatus(locationId: string, evseUID: string, newStatus: OCPIEvseStatus): Promise<void> {
    // Check for input parameter
    if (!locationId || !evseUID || !newStatus) {
      throw new BackendError({
        action: ServerAction.OCPI_PATCH_STATUS,
        message: 'Invalid parameters',
        module: MODULE_NAME, method: 'patchEVSEStatus',
      });
    }
    // Get locations endpoint url
    const locationsUrl = this.getEndpointUrl('locations', ServerAction.OCPI_PATCH_STATUS);
    // Read configuration to retrieve
    const countryCode = this.getLocalCountryCode(ServerAction.OCPI_PATCH_STATUS);
    const partyID = this.getLocalPartyID(ServerAction.OCPI_PATCH_STATUS);
    // Build url to EVSE
    const fullUrl = locationsUrl + `/${countryCode}/${partyID}/${locationId}/${evseUID}`;
    // Build payload
    const payload = { 'status': newStatus };
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_PATCH_STATUS,
      message: `Patch evse status at ${fullUrl}`,
      module: MODULE_NAME, method: 'patchEVSEStatus',
      detailedMessages: { payload }
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.patch(fullUrl, payload,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`,
            'Content-Type': 'application/json'
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, fullUrl, ServerAction.OCPI_PATCH_STATUS, MODULE_NAME, 'patchEVSEStatus');
    }
    // Check response
    if (!response.data) {
      throw new BackendError({
        action: ServerAction.OCPI_PATCH_STATUS,
        message: `Patch EVSE Status failed with status ${response.status}`,
        module: MODULE_NAME, method: 'patchEVSEStatus',
      });
    }
  }

  async checkCdr(transaction: Transaction): Promise<boolean> {
    if (!transaction.ocpiData || !transaction.ocpiData.cdr) {
      throw new BackendError({
        action: ServerAction.OCPI_CHECK_CDRS,
        message: `Unable to check cdr for transaction ${transaction.id}, ocpi data are missing`,
        module: MODULE_NAME, method: 'checkCdr',
      });
    }
    const cdrsUrl = this.getEndpointUrl('cdrs', ServerAction.OCPI_CHECK_CDRS);

    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_CHECK_CDRS,
      message: `Check cdr at ${cdrsUrl}/${transaction.ocpiData.cdr.id}`,
      module: MODULE_NAME, method: 'checkCdr'
    });
    // Check CDR
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.get(`${cdrsUrl}/${transaction.ocpiData.cdr.id}`,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, `${cdrsUrl}/${transaction.ocpiData.cdr.id}`,
        ServerAction.OCPI_CHECK_CDRS, MODULE_NAME, 'checkCdr');
    }
    if (response.status === 200 && response.data) {
      Logging.logDebug({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_CHECK_CDRS,
        message: 'Cdr checked with result',
        module: MODULE_NAME, method: 'checkCdr',
        detailedMessages: { response: response.data }
      });
      if (response.data.status_code === 3001) {
        await this.axiosInstance.post(cdrsUrl, transaction.ocpiData.cdr,
          {
            headers: {
              Authorization: `Token ${this.ocpiEndpoint.token}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          });
        return false;
      }
      const cdr = response.data.data as OCPICdr;
      if (cdr) {
        transaction.ocpiData.cdrCheckedOn = new Date();
        await TransactionStorage.saveTransaction(this.tenant.id, transaction);
        return true;
      }
    }
    throw new BackendError({
      action: ServerAction.OCPI_CHECK_CDRS,
      message: `Invalid response from Check cdr at ${cdrsUrl}/${transaction.ocpiData.cdr.id}`,
      module: MODULE_NAME, method: 'checkCdr',
      detailedMessages: { data: response.data }
    });
  }

  async checkSession(transaction: Transaction): Promise<boolean> {
    if (!transaction.ocpiData || !transaction.ocpiData.session) {
      throw new BackendError({
        action: ServerAction.OCPI_CHECK_SESSIONS,
        message: `Unable to check session for transaction ${transaction.id}, ocpi data are missing`,
        module: MODULE_NAME, method: 'checkSession',
      });
    }
    const sessionsUrl = `${this.getEndpointUrl('sessions', ServerAction.OCPI_CHECK_SESSIONS)}/${this.getLocalCountryCode(ServerAction.OCPI_CHECK_SESSIONS)}/${this.getLocalPartyID(ServerAction.OCPI_CHECK_SESSIONS)}/${transaction.ocpiData.session.id}`;
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_CHECK_SESSIONS,
      message: `Check session at ${sessionsUrl}`,
      module: MODULE_NAME, method: 'checkSession'
    });
    // Check
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.get(sessionsUrl,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, sessionsUrl, ServerAction.OCPI_CHECK_SESSIONS, MODULE_NAME, 'checkSession');
    }
    if (response.status === 200 && response.data) {
      Logging.logDebug({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_CHECK_SESSIONS,
        message: 'Session checked with result',
        module: MODULE_NAME, method: 'checkSession',
        detailedMessages: { response: response.data }
      });
      const session = response.data.data as OCPISession;
      if (session) {
        transaction.ocpiData.sessionCheckedOn = new Date();
        await TransactionStorage.saveTransaction(this.tenant.id, transaction);
        return true;
      }
    }
    throw new BackendError({
      action: ServerAction.OCPI_CHECK_CDRS,
      message: `Invalid response from Check session at ${sessionsUrl}`,
      module: MODULE_NAME, method: 'checkSession',
      detailedMessages: { data: response.data }
    });
  }

  async checkCdrs(): Promise<OCPIJobResult> {
    // Result
    const result: OCPIJobResult = {
      success: 0,
      failure: 0,
      total: 0,
      logs: [],
      objectIDsInFailure: [],
      objectIDsInSuccess: []
    };
    const transactions = await TransactionStorage.getTransactions(this.tenant.id, {
      issuer: true,
      ocpiCdrChecked: false
    }, Constants.DB_PARAMS_MAX_LIMIT);

    for (const transaction of transactions.result) {
      try {
        if (await this.checkCdr(transaction)) {
          result.success++;
          result.objectIDsInSuccess.push(String(transaction.id));
        } else {
          result.failure++;
          result.objectIDsInFailure.push(String(transaction.id));
        }
      } catch (error) {
        result.failure++;
        result.objectIDsInFailure.push(String(transaction.id));
        result.logs.push(
          `Failure checking cdr for transaction:${transaction.id}:${error.message}`
        );
      }
      result.total++;
    }
    return result;
  }

  async checkSessions(): Promise<OCPIJobResult> {
    // Result
    const result: OCPIJobResult = {
      success: 0,
      failure: 0,
      total: 0,
      logs: [],
      objectIDsInFailure: [],
      objectIDsInSuccess: []
    };
    const transactions = await TransactionStorage.getTransactions(this.tenant.id, {
      issuer: true,
      ocpiSessionChecked: false
    }, Constants.DB_PARAMS_MAX_LIMIT);

    for (const transaction of transactions.result) {
      if (transaction.stop && transaction.stop.timestamp) {
        try {
          if (await this.checkSession(transaction)) {
            result.success++;
            result.objectIDsInSuccess.push(String(transaction.id));
          } else {
            result.failure++;
            result.objectIDsInFailure.push(String(transaction.id));
          }
        } catch (error) {
          result.failure++;
          result.objectIDsInFailure.push(String(transaction.id));
          result.logs.push(
            `Failure checking session for transaction:${transaction.id}:${error.message}`
          );
        }
      }
      result.total++;
    }
    return result;
  }

  async checkLocation(location: OCPILocation): Promise<boolean> {
    // Get locations endpoint url
    const locationsUrl = this.getEndpointUrl('locations', ServerAction.OCPI_CHECK_LOCATIONS);
    // Read configuration to retrieve
    const countryCode = this.getLocalCountryCode(ServerAction.OCPI_CHECK_LOCATIONS);
    const partyID = this.getLocalPartyID(ServerAction.OCPI_CHECK_LOCATIONS);

    const locationUrl = locationsUrl + `/${countryCode}/${partyID}/${location.id}`;
    // Log
    Logging.logDebug({
      tenantID: this.tenant.id,
      action: ServerAction.OCPI_CHECK_LOCATIONS,
      message: `Check location at ${locationUrl}`,
      module: MODULE_NAME, method: 'checkLocation'
    });
    // Call IOP
    let response: AxiosResponse;
    try {
      response = await this.axiosInstance.get(locationUrl,
        {
          headers: {
            Authorization: `Token ${this.ocpiEndpoint.token}`
          },
          timeout: Constants.AXIOS_TIMEOUT
        });
    } catch (error) {
      // Handle errors
      Utils.handleAxiosError(error, locationUrl, ServerAction.OCPI_CHECK_LOCATIONS, MODULE_NAME, 'checkLocation');
    }
    if (response.status === 200 && response.data) {
      Logging.logDebug({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_CHECK_LOCATIONS,
        message: 'Location checked with result',
        module: MODULE_NAME, method: 'checkLocation',
        detailedMessages: { response: response.data }
      });
      const checkedLocation = response.data.data as OCPILocation;
      if (checkedLocation) {
        return true;
      }
    }
    throw new BackendError({
      action: ServerAction.OCPI_CHECK_LOCATIONS,
      message: 'Invalid response from Check location',
      module: MODULE_NAME, method: 'checkLocation',
      detailedMessages: { data: response.data }
    });
  }

  async checkLocations(): Promise<OCPIJobResult> {
    // Result
    const result: OCPIJobResult = {
      success: 0,
      failure: 0,
      total: 0,
      logs: [],
      objectIDsInFailure: [],
      objectIDsInSuccess: []
    };

    // Define get option
    const options = {
      'addChargeBoxID': true,
      countryID: this.getLocalCountryCode(ServerAction.OCPI_CHECK_LOCATIONS),
      partyID: this.getLocalPartyID(ServerAction.OCPI_CHECK_LOCATIONS)
    };

    // Get all EVSEs from all locations
    const locations = await OCPIMapping.getAllLocations(this.tenant, 0, 0, options);
    // Loop through locations
    for (const location of locations.result) {
      if (location) {
        try {
          if (await this.checkLocation(location)) {
            result.success++;
            result.objectIDsInSuccess.push(String(location.id));
          } else {
            result.failure++;
            result.objectIDsInFailure.push(String(location.id));
          }
        } catch (error) {
          result.failure++;
          result.objectIDsInFailure.push(String(location.id));
          result.logs.push(
            `Failure checking location ${location.id}:${error.message}`
          );
        }
      }
      result.total++;
    }

    return result;
  }

  /**
   * Send all EVSEs
   */
  async sendEVSEStatuses(processAllEVSEs = true): Promise<OCPIJobResult> {
    // Result
    const sendResult = {
      success: 0,
      failure: 0,
      total: 0,
      logs: [],
      chargeBoxIDsInFailure: [],
      chargeBoxIDsInSuccess: []
    };
    // Define get option
    const options = {
      'addChargeBoxID': true,
      countryID: this.getLocalCountryCode(ServerAction.OCPI_PATCH_STATUS),
      partyID: this.getLocalPartyID(ServerAction.OCPI_PATCH_STATUS)
    };
    // Get timestamp before starting process - to be saved in DB at the end of the process
    const startDate = new Date();
    // Check if all EVSEs should be processed - in case of delta send - process only following EVSEs:
    //    - EVSEs (ChargingStations) in error from previous push
    //    - EVSEs (ChargingStations) with status notification from latest pushDate
    let chargeBoxIDsToProcess = [];
    if (!processAllEVSEs) {
      // Get ChargingStation in Failure from previous run
      chargeBoxIDsToProcess.push(...this.getChargeBoxIDsInFailure());
      // Get ChargingStation with new status notification
      chargeBoxIDsToProcess.push(...await this.getChargeBoxIDsWithNewStatusNotifications());
      // Remove duplicates
      chargeBoxIDsToProcess = _.uniq(chargeBoxIDsToProcess);
    }
    // Get all EVSEs from all locations
    const locations = await OCPIMapping.getAllLocations(this.tenant, 0, 0, options);
    // Loop through locations
    for (const location of locations.result) {
      if (location && location.evses) {
        // Loop through EVSE
        for (const evse of location.evses) {
          // Total amount of EVSEs
          sendResult.total++;
          // Check if EVSE should be processed
          if (!processAllEVSEs && !chargeBoxIDsToProcess.includes(evse.chargeBoxId)) {
            continue;
          }
          // Process it if not empty
          if (evse && location.id && evse.uid) {
            try {
              await this.patchEVSEStatus(location.id, evse.uid, evse.status);
              sendResult.success++;
              sendResult.chargeBoxIDsInSuccess.push(evse.chargeBoxId);
              sendResult.logs.push(
                `Updated successfully status for locationID:${location.id} - evseID:${evse.evse_id}`
              );
            } catch (error) {
              sendResult.failure++;
              sendResult.chargeBoxIDsInFailure.push(evse.chargeBoxId);
              sendResult.logs.push(
                `Failure updating status for locationID:${location.id} - evseID:${evse.evse_id}:${error.message}`
              );
            }
            if (sendResult.failure > 0) {
              // Send notification to admins
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              NotificationHandler.sendOCPIPatchChargingStationsStatusesError(
                this.tenant.id,
                {
                  'location': location.name,
                  'evseDashboardURL': Utils.buildEvseURL((await TenantStorage.getTenant(this.tenant.id)).subdomain),
                }
              );
            }
          }
        }
      }
    }
    // Log error if any
    if (sendResult.failure > 0) {
      // Log error if failure
      Logging.logError({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: `Patching of ${sendResult.logs.length} EVSE statuses has been done with errors (see details)`,
        detailedMessages: { logs: sendResult.logs },
        module: MODULE_NAME, method: 'sendEVSEStatuses'
      });
    } else if (sendResult.success > 0) {
      // Log info
      Logging.logInfo({
        tenantID: this.tenant.id,
        action: ServerAction.OCPI_PATCH_STATUS,
        message: `Patching of ${sendResult.logs.length} EVSE statuses has been done successfully (see details)`,
        detailedMessages: { logs: sendResult.logs },
        module: MODULE_NAME, method: 'sendEVSEStatuses'
      });
    }
    // Save result in ocpi endpoint
    this.ocpiEndpoint.lastPatchJobOn = startDate;
    // Set result
    if (sendResult) {
      this.ocpiEndpoint.lastPatchJobResult = {
        'successNbr': sendResult.success,
        'failureNbr': sendResult.failure,
        'totalNbr': sendResult.total,
        'chargeBoxIDsInFailure': _.uniq(sendResult.chargeBoxIDsInFailure),
        'chargeBoxIDsInSuccess': _.uniq(sendResult.chargeBoxIDsInSuccess)
      };
    } else {
      this.ocpiEndpoint.lastPatchJobResult = {
        'successNbr': 0,
        'failureNbr': 0,
        'totalNbr': 0,
        'chargeBoxIDsInFailure': [],
        'chargeBoxIDsInSuccess': []
      };
    }
    // Save
    await OCPIEndpointStorage.saveOcpiEndpoint(this.tenant.id, this.ocpiEndpoint);
    // Return result
    return sendResult;
  }

  // Get ChargeBoxIds with new status notifications
  async getChargeBoxIDsWithNewStatusNotifications(): Promise<string[]> {
    // Get last job
    const lastPatchJobOn = this.ocpiEndpoint.lastPatchJobOn ? this.ocpiEndpoint.lastPatchJobOn : new Date();
    // Build params
    const params = { 'dateFrom': lastPatchJobOn };
    // Get last status notifications
    const statusNotificationsResult = await OCPPStorage.getStatusNotifications(this.tenant.id, params, Constants.DB_PARAMS_MAX_LIMIT);
    // Loop through notifications
    if (statusNotificationsResult.count > 0) {
      return statusNotificationsResult.result.map((statusNotification) => statusNotification.chargeBoxID);
    }
    return [];
  }

  async triggerJobs(): Promise<{ tokens: OCPIJobResult; locations: OCPIJobResult; cdrs: OCPIJobResult; sessions: OCPIJobResult }> {
    return {
      tokens: await this.pullTokens(false),
      locations: await this.sendEVSEStatuses(),
      cdrs: await this.checkCdrs(),
      sessions: await this.checkSessions()
    };
  }

  // Get ChargeBoxIDs in failure from previous job
  private getChargeBoxIDsInFailure(): string[] {
    if (this.ocpiEndpoint.lastPatchJobResult && this.ocpiEndpoint.lastPatchJobResult.chargeBoxIDsInFailure) {
      return this.ocpiEndpoint.lastPatchJobResult.chargeBoxIDsInFailure;
    }
    return [];
  }
}
