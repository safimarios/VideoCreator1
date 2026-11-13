// تصنيف أخطاء المزودين — قلب سياسة التبديل التسلسلي (قسم 4.2 من المواصفة)
// كل خطأ قادم من مزود خارجي يُرمى كـ ProviderError ليُصنَّف هنا

export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// خطأ معطيات — توقف فورًا (تبديل المفاتيح لن يحل طلبًا غير صالح)
export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ClassifiedError {
  cls: ErrorClass;
  status: number;
  message: string;
}

export function classifyProviderError(err: unknown): ClassifiedError {
  const status = err instanceof ProviderError ? err.status : 0;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // نفاد الرصيد يُفحص قبل 400 — بعض المزودين يرسلون نفاد الرصيد بحالة 400
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(message)
  ) {
    return { cls: "exhausted", status, message };
  }
  // مفتاح مرفوض → يُعطَّل تلقائيًا وينتقل للتالي
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication/.test(message)
  ) {
    return { cls: "disabled", status, message };
  }
  // الموديل غير مدعوم لدى هذا المزود → انتقل للمزود/المفتاح التالي
  // (رسالة kie الفعلية: "The model name you specified is not supported")
  if (/model.{0,40}not supported|not supported.{0,40}model|model not found|unsupported model|invalid model/.test(message) && [400, 404, 422].includes(status)) {
    return { cls: "provider", status, message };
  }
  // 400/422 بدون أنماط مفتاح/رصيد = معطيات تالفة → توقف نهائي
  if (status === 400 || status === 422) {
    return { cls: "params", status, message };
  }
  // 429 / 5xx / انقطاع شبكة / timeout = مؤقت → جرّب المفتاح التالي الآن
  return { cls: "temporary", status, message };
}

// هل رسالة فشل منتصف المهمة تشير لمشكلة مفتاح/رصيد؟ (قسم 4.3.2)
// إن كانت كذلك نعيد إنشاء نفس المهمة على المفتاح التالي بصمت
export function isKeyOrBalanceMessage(msg: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized/i.test(msg || "");
}
