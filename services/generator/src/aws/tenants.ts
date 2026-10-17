// The live distribution's tenants (hosting.ts): one per published domain, with a CloudFront-managed certificate.
// The multi-tenant distribution and its connection group are in infra (LIVE_DISTRIBUTION_ID, LIVE_CONNECTION_GROUP_ID).
import {
  CloudFrontClient,
  CNAMEAlreadyExists,
  CreateDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  EntityAlreadyExists,
  GetDistributionTenantCommand,
  GetManagedCertificateDetailsCommand,
  ResourceNotDisabled,
  UpdateDistributionTenantCommand,
  type DistributionTenant,
} from '@aws-sdk/client-cloudfront';
import { TenantTaken, type Tenant, type Tenants } from '../core/hosting';
import { RetryLater } from '../core/retry';

const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const view = (t: DistributionTenant | undefined): Tenant | undefined =>
  t?.Id
    ? { id: t.Id, name: t.Name ?? '', domains: (t.Domains ?? []).map((d) => ({ domain: d.Domain ?? '', status: d.Status })), certificateArn: t.Customizations?.Certificate?.Arn }
    : undefined;

const notFound = (error: unknown) => (error as { name?: string }).name === 'EntityNotFound';

async function getWithTag(id: string) {
  try {
    const result = await cloudfront.send(new GetDistributionTenantCommand({ Identifier: id }));
    return result;
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
}

export const tenants: Tenants = {
  async create({ name, domains, slug }) {
    try {
      const result = await cloudfront.send(
        new CreateDistributionTenantCommand({
          DistributionId: env('LIVE_DISTRIBUTION_ID'),
          ConnectionGroupId: env('LIVE_CONNECTION_GROUP_ID'),
          Name: name,
          Domains: domains.map((Domain) => ({ Domain })),
          Parameters: [{ Name: 'slug', Value: slug }],
          Enabled: true,
          // The domain already points at the connection group (the dns step), so CloudFront answers the HTTP challenge.
          ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront', PrimaryDomainName: domains[0], CertificateTransparencyLoggingPreference: 'enabled' },
        }),
      );
      if (!result.DistributionTenant?.Id) throw new Error(`tenant ${name}: no id`);
      return result.DistributionTenant.Id;
    } catch (error) {
      if (error instanceof CNAMEAlreadyExists || error instanceof EntityAlreadyExists) throw new TenantTaken(String(error));
      throw error;
    }
  },

  async get(id) {
    return view((await getWithTag(id))?.DistributionTenant);
  },

  async certificate(id) {
    try {
      const details = (await cloudfront.send(new GetManagedCertificateDetailsCommand({ Identifier: id }))).ManagedCertificateDetails;
      return details && { status: details.CertificateStatus, arn: details.CertificateArn };
    } catch (error) {
      if (notFound(error)) return undefined; // not requested yet, or still being set up
      throw error;
    }
  },

  async requestCertificate(id, domain) {
    const current = await getWithTag(id);
    if (!current?.DistributionTenant || !current.ETag) throw new Error(`tenant ${id} not found`);
    await cloudfront.send(
      new UpdateDistributionTenantCommand({
        Id: id,
        IfMatch: current.ETag,
        Domains: current.DistributionTenant.Domains?.map((d) => ({ Domain: d.Domain })),
        ManagedCertificateRequest: { ValidationTokenHost: 'cloudfront', PrimaryDomainName: domain, CertificateTransparencyLoggingPreference: 'enabled' },
      }),
    );
  },

  async useCertificate(id, arn) {
    const current = await getWithTag(id);
    if (!current?.DistributionTenant || !current.ETag) throw new Error(`tenant ${id} not found`);
    const { Domains, Customizations } = current.DistributionTenant;
    await cloudfront.send(
      new UpdateDistributionTenantCommand({
        Id: id,
        IfMatch: current.ETag,
        Domains: Domains?.map((d) => ({ Domain: d.Domain })),
        Customizations: { ...Customizations, Certificate: { Arn: arn } },
      }),
    );
  },

  async remove(id) {
    const current = await getWithTag(id);
    if (!current?.DistributionTenant || !current.ETag) return;
    if (current.DistributionTenant.Enabled) {
      await cloudfront.send(new UpdateDistributionTenantCommand({ Id: id, IfMatch: current.ETag, Domains: current.DistributionTenant.Domains?.map((d) => ({ Domain: d.Domain })), Enabled: false }));
      throw new RetryLater(`tenant ${id}: disabling, delete it again once deployed`);
    }
    try {
      await cloudfront.send(new DeleteDistributionTenantCommand({ Id: id, IfMatch: current.ETag }));
    } catch (error) {
      if (error instanceof ResourceNotDisabled || (error as { name?: string }).name === 'PreconditionFailed') throw new RetryLater(`tenant ${id}: not ready to delete yet`);
      throw error;
    }
  },
};
