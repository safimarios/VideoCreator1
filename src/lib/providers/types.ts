// أنواع مشتركة لطبقة المزودين — كل مزود ينفذ هذه الواجهة

export interface ProviderKey {
  id: string;
  provider: string;
  apiKey: string;
  label: string;
}

// المعطيات الخام بعد توحيد enum — كل مزود يحوّلها إلى شكله الخاص
export interface RawInput {
  prompt?: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId
  createTask(key: ProviderKey, providerModel: string, input: RawInput): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: ProviderKey, providerModel: string, input: RawInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckResult>;
}
