require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const DATA_DIR = process.env.DATA_DIR || __dirname;
const COHORTS = ['agm3', 'agm4'];

const dataFile = cohort => path.join(DATA_DIR, `data-${cohort}.json`);

function load(cohort) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(cohort), 'utf8'));
  } catch {
    return { contents: [], searches: [] };
  }
}

function save(cohort, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(dataFile(cohort), JSON.stringify(data, null, 2));
}

const CRITERIA = [
  {
    name: '직접답변',
    question: '질문에 대해 모호하지 않고 확정적인 답을, 앞부분에서 바로 제시하는가',
    source: 'Microsoft "Write in direct, factual language that provides definitive information" / 피해야 할 것: vague language',
    levels: '10=첫 문장이 곧 확정적인 답 / 7=앞부분에 답이 있으나 일부 모호함 / 4=답이 뒤에 묻혀 있거나 돌려 말함 / 0=답 없음',
  },
  {
    name: '제목·구조',
    question: '제목(소제목)이 구체적인 질문이나 주제를 반영하고, 한 단락에 한 주제만 다루는가',
    source: 'Microsoft "headings that reflect specific questions or topics", "short, well-defined sections that each focus on one idea" / 피해야 할 것: large unstructured text blocks',
    levels: '10=질문형·주제형 제목 + 짧은 단락이 주제별로 나뉨 / 7=제목은 좋으나 단락 구분이 약함 / 4=제목이 막연하거나 긴 덩어리 글 / 0=구조 없음',
  },
  {
    name: '사실·근거',
    question: '확인 가능한 사실(수치·날짜·금액·고유명사)과 출처가 있고, 명백한 사실 오류가 없는가',
    source: 'Google "clear sourcing", "easily-verified factual errors" / Microsoft "consistent with authoritative sources"',
    levels: '10=구체적 사실 여러 개 + 출처 제시, 오류 없음 / 7=구체적 사실은 있으나 출처 없음 / 4=일반론 위주 / 0=사실 오류가 있거나 근거 전무',
  },
  {
    name: '충실성',
    question: '질문에 필요한 내용을 빠짐없이 다루고, 뻔한 정보를 넘어선 유용한 정보를 주는가',
    source: 'Google "substantial, complete, or comprehensive description", "insightful analysis or interesting information beyond the obvious"',
    levels: '10=조건·예외·비교까지 완결적으로 설명 / 7=핵심은 다루나 일부 빠짐 / 4=한두 줄의 피상적 설명 / 0=도움 안 됨',
  },
  {
    name: '객관성',
    question: '과장·홍보성 표현 없이 중립적이고 신뢰할 수 있게 쓰였는가',
    source: 'Microsoft 피해야 할 것: "promotional language" / Google "avoid exaggerating or being shocking", "trust is most important"',
    levels: '10=중립적 사실 서술 / 7=약간의 홍보성 표현 / 4=홍보 문구가 많음 / 0=광고문에 가까움',
  },
];

const api = express.Router({ mergeParams: true });
app.use('/api/:cohort', (req, res, next) => {
  if (!COHORTS.includes(req.params.cohort)) return res.status(404).json({ error: '없는 기수' });
  next();
}, api);

app.get('/:cohort', (req, res, next) => {
  if (!COHORTS.includes(req.params.cohort)) return next();
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Content APIs ---
api.get('/contents', (req, res) => {
  const { contents } = load(req.params.cohort);
  res.json(contents);
});

api.post('/contents', (req, res) => {
  const { team, title, body } = req.body;
  if (!team || !title || !body) return res.status(400).json({ error: '필드 누락' });
  const data = load(req.params.cohort);
  const item = { id: Date.now(), team: parseInt(team), title, body, createdAt: new Date().toISOString() };
  data.contents.push(item);
  save(req.params.cohort, data);
  res.json(item);
});

api.delete('/contents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const data = load(req.params.cohort);
  const idx = data.contents.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: '없음' });
  data.contents.splice(idx, 1);
  save(req.params.cohort, data);
  res.json({ ok: true });
});

api.delete('/contents', (req, res) => {
  if (!process.env.RESET_PASSWORD || req.get('X-Reset-Password') !== process.env.RESET_PASSWORD) {
    return res.status(403).json({ error: '비밀번호가 틀렸습니다' });
  }
  save(req.params.cohort, { contents: [], searches: [] });
  res.json({ ok: true });
});

// --- Search API ---
api.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: '질문 없음' });

  const { contents, searches } = load(req.params.cohort);

  if (contents.length === 0) {
    return res.json({ answer: '업로드된 콘텐츠가 없습니다. 먼저 팀 콘텐츠를 업로드하세요.', citations: [], scores: {} });
  }

  const orderKey = c => crypto.createHash('sha256').update(query + ':' + c.id).digest('hex');
  const shuffled = [...contents].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  const teamNums = [...new Set(contents.map(c => c.team))].sort((a, b) => a - b);
  const contextText = shuffled.map(c =>
    `[팀${c.team}: ${c.title}]\n${c.body}`
  ).join('\n\n────────────\n\n');

  const systemPrompt = `당신은 AEO(Answer Engine Optimization) 시뮬레이터입니다.
아래 팀들이 올린 콘텐츠만을 기반으로 사용자 질문에 답하세요.

규칙:
1. 반드시 콘텐츠에 있는 정보만 사용하세요.
2. 인용한 팀은 반드시 [출처: 팀N] 형식으로 표시하세요. (예: [출처: 팀3])
3. 답변에 쓴 정보가 담긴 팀은 모두 출처로 표시하세요. 같은 정보가 여러 팀 콘텐츠에 있으면 그 팀들을 모두 표시하세요. 예: [출처: 팀1, 팀3]
4. 답변은 명확하고 간결하게 작성하세요.
5. 콘텐츠에 없는 내용은 "해당 정보는 업로드된 콘텐츠에 없습니다"라고 하세요.

=== 업로드된 팀 콘텐츠 ===

${contextText}`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1500,
      temperature: 0,
        seed: 42,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ]
    });

    const answer = response.choices[0].message.content;

    // Parse citations
    const citedTeams = new Set();
    for (const [block] of answer.matchAll(/[\[(（]\s*출처\s*[:：][^\])）]*[\])）]/g)) {
      for (const [, n] of block.matchAll(/팀\s*(\d+)/g)) citedTeams.add(parseInt(n));
    }
    const scores = Object.fromEntries([...citedTeams].map(t => [t, 1]));

    // AEO 분석 호출
    const judgeTeam = async team => {
      const teamText = shuffled.filter(c => c.team === team)
        .map(c => `[제목: ${c.title}]\n${c.body}`).join('\n\n────────────\n\n');
      const prompt = `당신은 AI 검색 답변에 인용될 콘텐츠를 평가하는 심사위원입니다.
아래 기준은 Microsoft와 Google이 공식 발표한 가이드에서 가져온 것입니다. 기준에 적힌 내용만으로 채점하고, 개인 취향이나 문체 선호는 반영하지 마세요.

질문: "${query}"

채점 방법:
- 아래는 한 팀이 올린 콘텐츠 전체입니다. 모든 콘텐츠를 끝까지 읽은 뒤, 이 질문에 가장 잘 답하는 콘텐츠 1개를 고르고 그 콘텐츠만 채점합니다.
- 질문에 대한 답의 일부라도 담긴 콘텐츠가 있으면 그 콘텐츠를 골라 구간 기준대로 채점합니다 (부분적인 답이면 직접답변·충실성을 4점 안팎으로).
- 질문과 관련된 정보가 한 글자도 없을 때만 모든 항목 0점, 근거콘텐츠는 "관련 콘텐츠 없음"으로 적습니다.
- 각 항목은 0~10점이며, 아래 구간 설명에 가장 가까운 점수를 줍니다 (10/7/4/0 사이 값 허용).

${CRITERIA.map((c, i) => `${i + 1}. ${c.name}: ${c.question}
   근거: ${c.source}
   ${c.levels}`).join('\n')}

=== 이 팀의 콘텐츠 ===
${teamText}

반드시 아래 JSON 형식으로만 답하세요:
{
${CRITERIA.map(c => `  "${c.name}": 점수,`).join('\n')}
  "근거콘텐츠": "채점한 콘텐츠 제목",
  "한줄평": "기준에 비추어 가장 큰 강점과 약점 한 줄"
}`;
      const r = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 800,
        temperature: 0,
        seed: 42,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      });
      const s = JSON.parse(r.choices[0].message.content);
      s.총점 = CRITERIA.reduce((sum, c) => sum + (Number(s[c.name]) || 0), 0);
      return s;
    };

    const analysis = {};
    const results = await Promise.allSettled(teamNums.map(judgeTeam));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') analysis[teamNums[i]] = r.value;
      else console.error(`팀${teamNums[i]} 분석 오류:`, r.reason?.message);
    });

    const record = {
      id: Date.now(),
      query,
      answer,
      citations: [...citedTeams],
      scores,
      analysis,
      createdAt: new Date().toISOString()
    };

    const data = load(req.params.cohort);
    data.searches.unshift(record);

    save(req.params.cohort, data);

    res.json({ answer, citations: [...citedTeams], scores, analysis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI API 오류: ' + err.message });
  }
});

api.get('/criteria', (req, res) => res.json(CRITERIA));

api.get('/leaderboard', (req, res) => {
  const { searches } = load(req.params.cohort);
  const counts = {};
  for (const s of searches) for (const t of s.citations) counts[t] = (counts[t] || 0) + 1;
  res.json({ totalSearches: searches.length, counts });
});

api.get('/searches', (req, res) => {
  const { searches } = load(req.params.cohort);
  res.json(searches.slice(0, 20));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AEO 경쟁 테스트 서버 시작`);
  console.log(`   http://localhost:${PORT}\n`);
});
