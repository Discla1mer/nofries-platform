targetScope = 'resourceGroup'

@description('Azure region for production security resources.')
param location string = resourceGroup().location

@description('Globally unique production application-data storage account name.')
param dataStorageName string

@description('Globally unique connector host/deployment storage account name.')
param connectorHostStorageName string

@description('System-assigned managed identity principal ID for the production web API.')
param webApiPrincipalId string

@description('System-assigned managed identity principal ID for the production connector.')
param connectorPrincipalId string

@description('Address for production Azure Monitor notifications.')
param notificationEmail string

param dataContainerName string = 'nofries-workspace'
param browserAuthContainerName string = 'nofries-browser-auth'
param connectorDeploymentContainerName string = 'app-package-nofries-agent-connector-flex'
param connectorIdentityName string = 'nofries-agent-connector-flex-uami'
param logAnalyticsName string = 'log-nofries-prod'
param webAppInsightsName string = 'appi-nofries-web-api-prod'
param connectorAppInsightsName string = 'appi-nofries-connector-prod'
param keyVaultName string
param actionGroupName string = 'ag-nofries-prod-critical'

@minValue(7)
@maxValue(365)
param dataRecoveryDays int = 30

@minValue(1)
@maxValue(365)
param evidenceRetentionDays int = 30

@minValue(1)
@maxValue(7)
param browserAuthRetentionDays int = 1

var commonTags = {
  environment: 'production'
  service: 'nofries'
  owner: 'joel-harvey'
  managedBy: 'github-actions'
  dataClassification: 'confidential'
}

var blobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var blobDataOwnerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var queueDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var tableDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var monitoringMetricsPublisherRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')

resource dataStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: dataStorageName
  location: location
  tags: commonTags
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource dataBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: dataStorage
  name: 'default'
  properties: {
    changeFeed: {
      enabled: true
      retentionInDays: dataRecoveryDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: dataRecoveryDays
    }
    deleteRetentionPolicy: {
      enabled: true
      days: dataRecoveryDays
      allowPermanentDelete: false
    }
    isVersioningEnabled: true
    restorePolicy: {
      enabled: true
      days: dataRecoveryDays - 1
    }
  }
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource browserAuthContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: dataBlobService
  name: browserAuthContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource dataLifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: dataStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'delete-production-evidence-after-retention'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: evidenceRetentionDays
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${dataContainerName}/evidence/'
              ]
            }
          }
        }
        {
          enabled: true
          name: 'delete-expired-browser-auth-records'
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: browserAuthRetentionDays
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: browserAuthRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: browserAuthRetentionDays
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${browserAuthContainerName}/browser-auth/'
              ]
            }
          }
        }
      ]
    }
  }
}

resource webApiDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dataContainer.id, webApiPrincipalId, blobDataContributorRoleId)
  scope: dataContainer
  properties: {
    principalId: webApiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource webApiBrowserAuthAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(browserAuthContainer.id, webApiPrincipalId, blobDataContributorRoleId)
  scope: browserAuthContainer
  properties: {
    principalId: webApiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource connectorDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dataContainer.id, connectorPrincipalId, blobDataContributorRoleId)
  scope: dataContainer
  properties: {
    principalId: connectorPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource connectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: connectorIdentityName
  location: location
  tags: commonTags
}

resource connectorHostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: connectorHostStorageName
  location: location
  tags: union(commonTags, {
    dataClassification: 'internal'
    purpose: 'function-host'
  })
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource connectorHostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: connectorHostStorage
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
      allowPermanentDelete: false
    }
    isVersioningEnabled: false
  }
}

resource connectorDeploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: connectorHostBlobService
  name: connectorDeploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource connectorHostBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectorHostStorage.id, connectorIdentity.id, blobDataOwnerRoleId)
  scope: connectorHostStorage
  properties: {
    principalId: connectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataOwnerRoleId
  }
}

resource connectorHostQueueAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectorHostStorage.id, connectorIdentity.id, queueDataContributorRoleId)
  scope: connectorHostStorage
  properties: {
    principalId: connectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: queueDataContributorRoleId
  }
}

resource connectorHostTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectorHostStorage.id, connectorIdentity.id, tableDataContributorRoleId)
  scope: connectorHostStorage
  properties: {
    principalId: connectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: tableDataContributorRoleId
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: union(commonTags, {
    dataClassification: 'internal'
  })
  properties: {
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource webAppInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: webAppInsightsName
  location: location
  kind: 'web'
  tags: union(commonTags, {
    dataClassification: 'internal'
  })
  properties: {
    Application_Type: 'web'
    DisableIpMasking: false
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    WorkspaceResourceId: logAnalytics.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource connectorAppInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: connectorAppInsightsName
  location: location
  kind: 'web'
  tags: union(commonTags, {
    dataClassification: 'internal'
  })
  properties: {
    Application_Type: 'web'
    DisableIpMasking: false
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    WorkspaceResourceId: logAnalytics.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource webAppInsightsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webAppInsights.id, webApiPrincipalId, monitoringMetricsPublisherRoleId)
  scope: webAppInsights
  properties: {
    principalId: webApiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringMetricsPublisherRoleId
  }
}

resource connectorAppInsightsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectorAppInsights.id, connectorPrincipalId, monitoringMetricsPublisherRoleId)
  scope: connectorAppInsights
  properties: {
    principalId: connectorPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: monitoringMetricsPublisherRoleId
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: commonTags
  properties: {
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
    softDeleteRetentionInDays: 90
    tenantId: subscription().tenantId
  }
}

resource webApiKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApiPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: webApiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: union(commonTags, {
    dataClassification: 'internal'
  })
  properties: {
    enabled: true
    groupShortName: 'NoFries'
    emailReceivers: [
      {
        emailAddress: notificationEmail
        name: 'Joel Harvey'
        useCommonAlertSchema: true
      }
    ]
  }
}

output actionGroupId string = actionGroup.id
output connectorAppInsightsConnectionString string = connectorAppInsights.properties.ConnectionString
output connectorDeploymentContainerName string = connectorDeploymentContainer.name
output connectorHostStorageName string = connectorHostStorage.name
output connectorIdentityClientId string = connectorIdentity.properties.clientId
output connectorIdentityId string = connectorIdentity.id
output browserAuthContainerId string = browserAuthContainer.id
output browserAuthContainerName string = browserAuthContainer.name
output dataContainerId string = dataContainer.id
output dataStorageName string = dataStorage.name
output keyVaultId string = keyVault.id
output keyVaultUri string = keyVault.properties.vaultUri
output logAnalyticsId string = logAnalytics.id
output webAppInsightsConnectionString string = webAppInsights.properties.ConnectionString
