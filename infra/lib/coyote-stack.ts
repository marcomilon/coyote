import { Stack, type StackProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export type EnvName = 'dev' | 'prod';

export interface CoyoteStackProps extends StackProps {
  envName: EnvName;
  /** Brand domain (app, API, email). Unset = domainless mode. */
  domainName?: string;
  /** Registrable domain for user sites. Unset = domainless mode. */
  sitesDomainName?: string;
}

export class CoyoteStack extends Stack {
  constructor(scope: Construct, id: string, props: CoyoteStackProps) {
    super(scope, id, props);

    if (Boolean(props.domainName) !== Boolean(props.sitesDomainName)) {
      throw new Error('Set both domainName and sitesDomainName, or neither (domainless mode).');
    }

    Tags.of(this).add('project', 'coyote');
    Tags.of(this).add('env', props.envName);
  }
}
