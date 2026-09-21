import { createHash } from 'node:crypto';
import { Stack, aws_bedrock as bedrock } from 'aws-cdk-lib';
import { Construct } from 'constructs';

const BLOCKED_MESSAGE = 'No podemos crear este sitio.';

/**
 * Hard harms only. The "main activity" rules (bars, liquor, tobacco, pawn shops, money exchange) stay in
 * the pre-screen classifier: a topic filter would also block a restaurant that mentions beer.
 * Definitions ≤ 200 chars, examples ≤ 100 chars, at most 5 examples each.
 */
const DENIED_TOPICS: { name: string; definition: string; examples: string[] }[] = [
  {
    name: 'Adult services',
    definition: 'Escort or sexual services, erotic massage, pornography, or any sexual content involving minors.',
    examples: ['Agencia de escorts y acompañantes VIP', 'Masajes eróticos con final feliz', 'Acompanhantes de luxo em São Paulo'],
  },
  {
    name: 'Gambling',
    definition: 'Casinos, sports betting, betting tips, lotteries, bingo, or any game of chance played for money.',
    examples: ['Casino en línea con bono de bienvenida', 'Palpites de apostas esportivas', 'Agencia de lotería y quiniela'],
  },
  {
    name: 'Drugs and weapons',
    definition: 'Selling recreational drugs including cannabis, prescription drugs without a prescription, firearms, or ammunition.',
    examples: ['Venta de marihuana con entrega discreta', 'Tramadol y clonazepam sin receta', 'Pistolas y municiones sin papeles'],
  },
  {
    name: 'Financial fraud',
    definition: 'Guaranteed investment returns, crypto investment schemes, pyramid or recruit-to-earn schemes, or loans that require an advance fee.',
    examples: ['Gana 30% mensual garantizado con nuestro bot', 'Invita a 8 personas y recibe 4000', 'Deposita el seguro por adelantado y liberamos tu crédito'],
  },
  {
    name: 'Impersonation and credential collection',
    definition: 'Posing as a bank, payment company, government agency, courier, or known brand, or asking people for passwords, PINs, card numbers, or codes.',
    examples: ['Soporte oficial de tu banco, verifica tu cuenta', 'Atualize seus dados e desbloqueie seu cartão', 'Ingresa tu número de tarjeta, NIP y código SMS'],
  },
  {
    name: 'Piracy and counterfeits',
    definition: 'Pirated films or TV, software cracks, fake documents, diplomas or licences, or counterfeit goods.',
    examples: ['IPTV con 5000 canales premium pirata', 'Títulos universitarios sin examen', 'Réplicas AAA de marcas de lujo'],
  },
  {
    name: 'Political campaigns',
    definition: 'Election campaign material for a candidate or party, or content whose purpose is religious proselytising.',
    examples: ['Sitio de campaña del candidato a la alcaldía', 'Vote no nosso candidato a vereador'],
  },
];

const SCAM_WORDS = [
  'verifica tu cuenta', 'verifique su cuenta', 'verifique sua conta', 'actualiza tus datos', 'atualize seus dados',
  'confirme seus dados', 'cuenta suspendida', 'cuenta bloqueada', 'conta suspensa', 'conta bloqueada',
  'desbloquea tu cuenta', 'desbloqueie sua conta', 'clave dinámica', 'reclama tu premio', 'resgate seu prêmio',
];

const filter = (type: string, strength: string, output = strength) => ({
  type,
  inputStrength: strength,
  outputStrength: output,
});

/** Bedrock Guardrail (Standard tier, needed for Portuguese) plus a numbered version the Lambdas pin to. */
export class CoyoteGuardrail extends Construct {
  readonly guardrailId: string;
  readonly guardrailArn: string;
  readonly version: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const stack = Stack.of(this);

    const config: Pick<bedrock.CfnGuardrailProps, 'contentPolicyConfig' | 'topicPolicyConfig' | 'wordPolicyConfig'> = {
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: 'STANDARD' },
        filtersConfig: [
          filter('SEXUAL', 'HIGH'),
          filter('HATE', 'HIGH'),
          // MEDIUM: HIGH rejects butchers, martial-arts gyms, tattoo studios. Tune on the fixtures.
          filter('VIOLENCE', 'MEDIUM'),
          filter('INSULTS', 'MEDIUM'),
          filter('MISCONDUCT', 'MEDIUM'),
          filter('PROMPT_ATTACK', 'HIGH', 'NONE'),
        ],
      },
      topicPolicyConfig: {
        topicsTierConfig: { tierName: 'STANDARD' },
        topicsConfig: DENIED_TOPICS.map((topic) => ({ ...topic, type: 'DENY' })),
      },
      wordPolicyConfig: {
        managedWordListsConfig: [{ type: 'PROFANITY' }],
        wordsConfig: SCAM_WORDS.map((text) => ({ text })),
      },
    };

    const guardrail = new bedrock.CfnGuardrail(this, 'Resource', {
      name: 'coyote',
      description: 'Content safety for generated business websites',
      blockedInputMessaging: BLOCKED_MESSAGE,
      blockedOutputsMessaging: BLOCKED_MESSAGE,
      // The Standard tier runs through cross-region guardrail inference.
      crossRegionConfig: {
        guardrailProfileArn: `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:guardrail-profile/us.guardrail.v1:0`,
      },
      ...config,
    });

    // Version properties are create-only: a new hash makes CloudFormation publish a new version.
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
    const version = new bedrock.CfnGuardrailVersion(this, 'Version', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `config ${hash}`,
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailArn = guardrail.attrGuardrailArn;
    this.version = version.attrVersion;
  }
}
