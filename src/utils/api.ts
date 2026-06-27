import type { ExtractedContent, ClassificationResult, AppSettings } from '../types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

function buildPrompt(content: ExtractedContent): string {
  const websiteUrl = content.url;
  const contentForPrompt = [
    content.title       ? `Title: ${content.title}`                          : '',
    content.metaDescription ? `Meta: ${content.metaDescription}`             : '',
    content.h1s.length  ? `H1: ${content.h1s.slice(0, 3).join(' | ')}`      : '',
    content.h2s.length  ? `H2: ${content.h2s.slice(0, 5).join(' | ')}`      : '',
    `Body: ${content.bodyText.substring(0, 3000)}`,
  ].filter(Boolean).join('\n');

  return `You are an expert company research analyst helping sales teams qualify companies for outbound prospecting.

Analyze the website content and classify the company.

Website URL:
${websiteUrl}

Website Content:
${contentForPrompt}

Classification Rules:

1. BUSINESS TYPE
Choose ONE:
- B2B = primarily sells to businesses
- B2C = primarily sells directly to consumers
- B2B2C = sells through businesses to consumers
Use website messaging, customer examples, pricing, and use cases as evidence.

2. COMPANY MODEL
Choose ONE:
- Product = software, SaaS, platform, app, technology product
- Services = consulting, agency, outsourcing, implementation, staffing, managed services
- Marketplace = connects buyers and sellers
- Hybrid = significant product + service offerings

3. INDUSTRY
Choose ONLY from:
["Fintech", "Healthcare", "Edtech", "Martech", "HRTech", "SalesTech", "Cybersecurity", "Ecommerce", "IT Services", "AI", "Analytics", "DevTools", "Cloud Infrastructure", "Real Estate", "Logistics", "Travel", "LegalTech", "Manufacturing", "Retail", "Media", "Other"]

4. TARGET CUSTOMER TYPE
Choose all that apply:
["Startup", "SMB", "Mid Market", "Enterprise"]
Infer from pricing, case studies, customer logos, language, and solutions offered.

5. GROWTH STAGE
Choose ONE: Startup, Growth, Scale Up, or Enterprise
Use signals: company maturity, customer logos, geographic footprint, product breadth, enterprise focus, hiring scale.

6. GEOGRAPHY
Identify countries or regions actively targeted by the company.

7. IDEAL CUSTOMER PROFILE (ICP)
Describe: industry served, buyer persona, company size, primary use case.

8. SERVICES OFFERED
List key offerings mentioned on the website.

9. BUYER PERSONAS
Identify likely buyers. Examples: ["Founder", "CEO", "CTO", "VP Engineering", "Head of Marketing", "CFO", "HR Director"]

10. EVIDENCE
For every classification, identify the website evidence used.

Return ONLY valid JSON:
{
  "companyName": "",
  "businessType": "",
  "businessTypeConfidence": 0,
  "companyModel": "",
  "companyModelConfidence": 0,
  "industry": "",
  "industryConfidence": 0,
  "targetCustomerType": [],
  "growthStage": "",
  "companyDescription": "",
  "servicesOffered": [],
  "buyerPersonas": [],
  "geography": [],
  "icp": {
    "industriesServed": [],
    "companySizes": [],
    "buyerRoles": [],
    "useCases": []
  },
  "evidence": {
    "businessType": "",
    "companyModel": "",
    "industry": "",
    "targetCustomerType": "",
    "growthStage": ""
  }
}`;
}

export async function classifyCompany(
  content: ExtractedContent,
  settings: AppSettings
): Promise<ClassificationResult> {
  if (!settings.apiKey) {
    throw new Error('API key not configured. Open Settings to add your Anthropic API key.');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content: buildPrompt(content) }],
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body?.error as Record<string, unknown>)?.message as string | undefined;
    throw new Error(errMsg || `Anthropic API error ${response.status}`);
  }

  const data = await response.json() as Record<string, unknown>;
  const contentArr = data?.content as Array<Record<string, unknown>> | undefined;
  const text = (contentArr?.[0]?.text as string) || '';

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI returned an invalid response format');

  try {
    return JSON.parse(match[0]) as ClassificationResult;
  } catch {
    throw new Error('Failed to parse AI response as JSON');
  }
}
