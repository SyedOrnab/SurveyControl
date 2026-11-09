/* eslint-disable */
import { IInputs, IOutputs } from './generated/ManifestTypes';

// ===================== CHANGE ME (values from your environment) =====================
const STATUS = { Draft: 163120002, InProgress: 163120000, Completed: 163120001 };
const QTYPE = { Single: 163120000, Multi: 163120001, Open: 163120002 };
const SET_RES = 'btcl_surveyreses';
const SET_QUES = 'btcl_surveyqueses';
const SET_ANS = 'btcl_surveyanses';
const NAV_DET_RESPONSE = 'btcl_Response';
const NAV_DET_QUESTION = 'btcl_Question';
const NAV_DET_ANSWER = 'btcl_SelectedAnswer';
// ====================================================================================

interface Answer { id: string; text: string; code: string; }
interface Question { id: string; text: string; code: string; sequence: number; kind: string; answers: Answer[]; }

export class SurveyControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private context!: ComponentFramework.Context<IInputs>;
  private root!: HTMLDivElement;
  private recordId = '';
  private doctorId = '';
  private productId = '';
  private questions: Question[] = [];
  private selected: { [questionId: string]: string[] } = {};
  private typed: { [questionId: string]: string } = {};
  private busy = false;

  public init(context: ComponentFramework.Context<IInputs>, notifyOutputChanged: () => void, state: ComponentFramework.Dictionary, container: HTMLDivElement): void {
    this.context = context;
    this.root = document.createElement('div');
    this.root.className = 'sv-root';
    container.appendChild(this.root);
    this.checkRecord();
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.context = context;
    this.checkRecord();
  }

  public getOutputs(): IOutputs { return {}; }

  public destroy(): void { }

  // ---------- which record are we on? ----------
  private checkRecord(): void {
    const info = (this.context.mode as any).contextInfo;
    const id = info && info.entityId ? String(info.entityId).replace(/[{}]/g, '').toLowerCase() : '';
    if (id !== this.recordId || this.root.childNodes.length === 0) {
      this.recordId = id;
      void this.load();
    }
  }

  // ---------- decide what to show ----------
  private async load(): Promise<void> {
    this.showMessage('Loading survey...');
    try {
      if (!this.recordId) {
        this.showMessage('Please select the doctor (and product), save the response, and the survey will appear here.');
        return;
      }
      const res = await this.context.webAPI.retrieveRecord('btcl_surveyres', this.recordId, '?$select=btcl_surveystatus,_btcl_doctor_value,_btcl_product_value');
      this.doctorId = res['_btcl_doctor_value'] || '';
      this.productId = res['_btcl_product_value'] || '';
      const status = res['btcl_surveystatus'];
      if (status === STATUS.Completed) {
        this.showMessage('This survey is submitted. See the Answers Summary tab.');
        return;
      }
      if (status === STATUS.InProgress) {
        await this.loadQuestions();
        this.render();
        return;
      }
      this.renderStart();
    } catch (e) {
      this.showError(e);
    }
  }

  // ---------- start screen ----------
  private renderStart(): void {
    this.clear();
    const card = this.div('sv-card');
    if (!this.doctorId) {
      card.appendChild(this.div('sv-info', 'Please select the doctor and save the response before starting.'));
    } else {
      card.appendChild(this.div('sv-info', 'Ready to start. Click Start Survey.'));
    }
    const btn = this.button('Start Survey', 'sv-btn sv-btn-primary', () => { void this.startSurvey(); });
    btn.disabled = !this.doctorId;
    card.appendChild(btn);
    this.root.appendChild(card);
  }

  private async startSurvey(): Promise<void> {
    try {
      const data: any = { btcl_surveystatus: STATUS.InProgress, btcl_surveystarttime: new Date().toISOString() };
      await this.context.webAPI.updateRecord('btcl_surveyres', this.recordId, data);
      await this.loadQuestions();
      this.render();
    } catch (e) {
      this.showError(e);
    }
  }

  // ---------- THE FILTER: questions (with type) and their answers ----------
  private async loadQuestions(): Promise<void> {
    // product on the response = product-wise survey; no product = general survey
    let filter = 'btcl_isactive eq true';
    if (this.productId) {
      filter += ' and _btcl_product_value eq ' + this.productId;
    } else {
      filter += ' and _btcl_product_value eq null';
    }
    const q = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyques', '?$select=btcl_surveyquesid,btcl_questiontext,btcl_questioncode,btcl_sequence,btcl_questiontype&$filter=' + filter + '&$orderby=btcl_sequence asc');
    const list: Question[] = [];
    q.entities.forEach((e) => {
      let kind = 'single';
      if (e['btcl_questiontype'] === QTYPE.Multi) { kind = 'multi'; }
      if (e['btcl_questiontype'] === QTYPE.Open) { kind = 'open'; }
      list.push({ id: e['btcl_surveyquesid'], text: e['btcl_questiontext'], code: e['btcl_questioncode'], sequence: e['btcl_sequence'] || 0, kind: kind, answers: [] });
    });
    this.questions = [];
    this.selected = {};
    this.typed = {};
    if (list.length === 0) { return; }

    // answers are only needed for Single and Multi questions
    const withAnswers = list.filter((x) => x.kind !== 'open');
    if (withAnswers.length > 0) {
      const idFilter = withAnswers.map((x) => '_btcl_question_value eq ' + x.id).join(' or ');
      const a = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyans', '?$select=btcl_surveyansid,btcl_answertext,btcl_answercode,btcl_sortorder,_btcl_question_value&$filter=btcl_isactive eq true and (' + idFilter + ')&$orderby=btcl_sortorder asc');
      a.entities.forEach((e) => {
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === e['_btcl_question_value']) {
            list[i].answers.push({ id: e['btcl_surveyansid'], text: e['btcl_answertext'], code: e['btcl_answercode'] });
          }
        }
      });
    }
    this.questions = list.filter((x) => x.kind === 'open' || x.answers.length > 0);
  }

  // ---------- is this question answered? ----------
  private isAnswered(q: Question): boolean {
    if (q.kind === 'open') {
      return (this.typed[q.id] || '').trim().length > 0;
    }
    return (this.selected[q.id] || []).length > 0;
  }

  // ---------- draw ALL questions on one page, each by its type ----------
  private render(): void {
    this.clear();
    if (this.questions.length === 0) {
      this.showMessage('No survey questions are set up for this selection. Please contact your administrator.');
      return;
    }
    const card = this.div('sv-card');
    const counter = this.div('sv-progress-text');
    const bar = this.div('sv-bar');
    const fill = this.div('sv-bar-fill');
    bar.appendChild(fill);
    card.appendChild(counter);
    card.appendChild(bar);

    const submit = this.button('Submit Survey', 'sv-btn sv-btn-primary', () => { void this.submit(); });

    const refresh = () => {
      let n = 0;
      for (let i = 0; i < this.questions.length; i++) {
        if (this.isAnswered(this.questions[i])) { n++; }
      }
      counter.textContent = n + ' of ' + this.questions.length + ' answered';
      fill.style.width = Math.round((n / this.questions.length) * 100) + '%';
    };

    this.questions.forEach((q, qi) => {
      const block = this.div('sv-block');
      block.appendChild(this.div('sv-question', (qi + 1) + '. ' + q.text));

      if (q.kind === 'open') {
        block.appendChild(this.div('sv-hint', 'Type your answer'));
        const ta = document.createElement('textarea');
        ta.className = 'sv-text';
        ta.rows = 3;
        ta.value = this.typed[q.id] || '';
        ta.oninput = () => { this.typed[q.id] = ta.value; refresh(); };
        block.appendChild(ta);
      } else {
        block.appendChild(this.div('sv-hint', q.kind === 'multi' ? 'Select all that apply' : 'Select one'));
        const list = this.div('sv-answers');
        const buttons: HTMLButtonElement[] = [];
        const paint = () => {
          const sel = this.selected[q.id] || [];
          for (let k = 0; k < buttons.length; k++) {
            const on = sel.indexOf(q.answers[k].id) >= 0;
            buttons[k].className = 'sv-answer' + (on ? ' sv-selected' : '');
            if (q.kind === 'multi') {
              buttons[k].textContent = (on ? '\u2611 ' : '\u2610 ') + q.answers[k].text;
            }
          }
        };
        q.answers.forEach((a) => {
          const b = this.button(a.text, 'sv-answer', () => {
            if (q.kind === 'multi') {
              const cur = (this.selected[q.id] || []).slice();
              const pos = cur.indexOf(a.id);
              if (pos >= 0) { cur.splice(pos, 1); } else { cur.push(a.id); }
              this.selected[q.id] = cur;
            } else {
              this.selected[q.id] = [a.id];
            }
            paint();
            refresh();
          });
          buttons.push(b);
          list.appendChild(b);
        });
        paint();
        block.appendChild(list);
      }
      card.appendChild(block);
    });

    const nav = this.div('sv-nav');
    nav.appendChild(submit);
    card.appendChild(nav);
    this.root.appendChild(card);
    refresh();
  }

  // ---------- SUBMIT: save every answer, then close the survey ----------
  private async submit(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    try {
      // remove rows left by an earlier failed attempt, so nothing is duplicated
      const old = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyresdetail', '?$select=btcl_surveyresdetailid&$filter=_btcl_response_value eq ' + this.recordId);
      for (let i = 0; i < old.entities.length; i++) {
        await this.context.webAPI.deleteRecord('btcl_surveyresdetail', old.entities[i]['btcl_surveyresdetailid']);
      }
      // one row per answered Single / Open text question, one row per ticked answer for Multi; unanswered questions are skipped
      for (let i = 0; i < this.questions.length; i++) {
        const q = this.questions[i];
        if (q.kind === 'open') {
          const t = (this.typed[q.id] || '').trim();
          if (t.length > 0) { await this.saveRow(q, null, t); }
        } else {
          const sel = this.selected[q.id] || [];
          for (let k = 0; k < q.answers.length; k++) {
            if (sel.indexOf(q.answers[k].id) >= 0) {
              await this.saveRow(q, q.answers[k], q.answers[k].text);
            }
          }
        }
      }
      // End Time is set automatically here
      await this.context.webAPI.updateRecord('btcl_surveyres', this.recordId, { btcl_surveystatus: STATUS.Completed, btcl_surveyendtime: new Date().toISOString() });
      this.clear();
      const card = this.div('sv-card');
      card.appendChild(this.div('sv-info', 'Thank you. The survey is submitted.'));
      card.appendChild(this.button('Close survey', 'sv-btn sv-btn-primary', () => {
        this.context.navigation.openForm({ entityName: 'btcl_surveyres', entityId: this.recordId });
      }));
      this.root.appendChild(card);
    } catch (e) {
      this.render();
      this.root.appendChild(this.div('sv-error', 'Could not submit: ' + (e && (e as any).message ? (e as any).message : String(e))));
    } finally {
      this.busy = false;
    }
  }

  private async saveRow(q: Question, a: Answer | null, text: string): Promise<void> {
    const data: any = {
      btcl_name: a ? q.code + ' - ' + a.code : q.code,
      btcl_questioncode: q.code,
      btcl_questiontext: q.text,
      btcl_answercode: a ? a.code : '',
      btcl_answertext: text,
      btcl_sortorder: q.sequence,
      btcl_isrequired: false
    };
    data[NAV_DET_RESPONSE + '@odata.bind'] = '/' + SET_RES + '(' + this.recordId + ')';
    data[NAV_DET_QUESTION + '@odata.bind'] = '/' + SET_QUES + '(' + q.id + ')';
    if (a) { data[NAV_DET_ANSWER + '@odata.bind'] = '/' + SET_ANS + '(' + a.id + ')'; }
    await this.context.webAPI.createRecord('btcl_surveyresdetail', data);
  }

  // ---------- small helpers ----------
  private div(cls: string, text?: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    if (text) { d.textContent = text; }
    return d;
  }

  private button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  private clear(): void {
    while (this.root.firstChild) { this.root.removeChild(this.root.firstChild); }
  }

  private showMessage(text: string): void {
    this.clear();
    const card = this.div('sv-card');
    card.appendChild(this.div('sv-info', text));
    this.root.appendChild(card);
  }

  private showError(e: any): void {
    this.clear();
    const card = this.div('sv-card');
    card.appendChild(this.div('sv-error', 'Something went wrong: ' + (e && e.message ? e.message : String(e))));
    this.root.appendChild(card);
  }
}