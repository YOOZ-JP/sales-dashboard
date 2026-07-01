# Title Alias Tables

플랫폼별 raw 타이틀 → 사람이 사용하는 canonical 타이틀 매핑.
리버스엔지니어링으로 추출된 규칙을 담는 곳.

스키마:
```json
{
  "platform": "booklive",
  "rules": [
    { "pattern": "re-regex", "replace": "정규화된 결과", "note": "왜 이 룰인지" }
  ],
  "aliases": {
    "raw title": "canonical title"
  }
}
```
