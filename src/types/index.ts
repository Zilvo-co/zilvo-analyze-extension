export interface ClassificationICP {
  industriesServed: string[];
  companySizes: string[];
  buyerRoles: string[];
  useCases: string[];
}

export interface ClassificationEvidence {
  businessType: string;
  companyModel: string;
  industry: string;
  targetCustomerType: string;
  growthStage: string;
}

export interface ClassificationResult {
  companyName: string;
  businessType: string;
  businessTypeConfidence: number;
  companyModel: string;
  companyModelConfidence: number;
  industry: string;
  industryConfidence: number;
  targetCustomerType: string[];
  growthStage: string;
  companyDescription: string;
  servicesOffered: string[];
  buyerPersonas: string[];
  geography: string[];
  icp: ClassificationICP;
  evidence: ClassificationEvidence;
}

export interface ExtractedContent {
  title: string;
  metaDescription: string;
  h1s: string[];
  h2s: string[];
  bodyText: string;
  url: string;
}

export interface LinkedInData {
  companyName: string | null;
  websiteUrl: string | null;
  error?: string;
}

export interface LinkedInCompanyData {
  companyName: string | null;
  websiteUrl: string | null;
  linkedinUrl: string;
  industry: string | null;
  employeeCount: string | null;
  followerCount: string | null;
  error?: string;
}

export interface AppSettings {
  apiKey: string;
  model: string;
}

export type ProgressStep =
  | 'opening_linkedin'
  | 'extracting_linkedin'
  | 'opening_website'
  | 'extracting_content'
  | 'classifying'
  | 'done';

export type AppStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AppState {
  status: AppStatus;
  step?: ProgressStep;
  stepMessage?: string;
  result?: ClassificationResult;
  companyName?: string | null;
  websiteUrl?: string | null;
  error?: string;
}

export interface ClassifyMessage {
  type: 'CLASSIFY_COMPANY';
  linkedinUrl: string;
}

export interface ProgressMessage {
  type: 'CLASSIFICATION_PROGRESS';
  step: ProgressStep;
  message: string;
}

export interface CompleteMessage {
  type: 'CLASSIFICATION_COMPLETE';
  result: ClassificationResult;
  companyName: string | null;
  websiteUrl: string | null;
}

export interface ErrorMessage {
  type: 'CLASSIFICATION_ERROR';
  error: string;
}

export type BackgroundMessage =
  | ClassifyMessage
  | ProgressMessage
  | CompleteMessage
  | ErrorMessage;

// ── Company Intelligence types ────────────────────────────────────────────────

export interface ZilvoAuth {
  token: string;
  name: string;
  email: string;
}

export interface CIAnalysisResult {
  companyName?: string;
  businessType?: string;
  companyModel?: string;
  industry?: string;
  targetCustomerType?: string[];
  growthStage?: string;
  companyDescription?: string;
  servicesOffered?: string[];
  geography?: string[];
  icp?: string;
}

export interface AnalyzeForCIMessage {
  type: 'ANALYZE_FOR_CI';
  websiteUrl?: string;
  linkedinUrl?: string;
  companyName?: string | null;
  linkedinIndustry?: string;
  linkedinEmployeeCount?: string;
  linkedinFollowerCount?: string;
  pageContent?: string;
  userInputField?: string;
}

export interface CIProgressMessage {
  type: 'CI_PROGRESS';
  step: string;
  message: string;
}

export interface CICompleteMessage {
  type: 'CI_COMPLETE';
  jobId: string;
}

export interface CIErrorMessage {
  type: 'CI_ERROR';
  error: string;
}

export type CIBackgroundMessage =
  | AnalyzeForCIMessage
  | CIProgressMessage
  | CICompleteMessage
  | CIErrorMessage;
