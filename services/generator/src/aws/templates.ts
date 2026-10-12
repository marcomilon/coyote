import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { TemplateInfo, TemplateLibrary } from '../core/template-writer';

/** The page templates in the page-skills bucket: `templates/index.json` and `templates/<id>.html` (`./coyote.sh page-templates`). */
export function s3Templates(s3: S3Client, bucket: string | undefined): TemplateLibrary {
  const read = async (key: string): Promise<string | undefined> => {
    if (!bucket) return undefined;
    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await Body?.transformToString();
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return undefined;
      throw error;
    }
  };
  return {
    list: async () => {
      const index = await read('templates/index.json');
      return index ? (JSON.parse(index) as TemplateInfo[]) : [];
    },
    get: (id) => read(`templates/${id}.html`),
  };
}
