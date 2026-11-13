// إخفاء المفتاح إلزاميًا في كل الاستجابات — أول 7 أحرف + نقاط + آخر 4
// المفاتيح القصيرة: أول 3 أحرف + نقاط
export function maskKey(key: string): string {
  if (key.length < 12) {
    return `${key.slice(0, 3)}••••`;
  }
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}
