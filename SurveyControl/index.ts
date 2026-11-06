/* eslint-disable */
import { IInputs, IOutputs } from './generated/ManifestTypes';

// ===================== CHANGE ME (values from step 6, part C) =====================
const STATUS = { Draft: 790830002, InProgress: 790830000, Completed: 790830001 };
const SET_RES = 'btcl_surveyreses';
const SET_QUES = 'btcl_surveyqueses';
const SET_ANS = 'btcl_surveyanses';
const NAV_DET_RESPONSE = 'btcl_Response';
const NAV_DET_QUESTION = 'btcl_Question';
const NAV_DET_ANSWER = 'btcl_SelectedAnswer';
// =================================================================================

interface Answer { id: string; text: string; code: string; }
interface Question { id: string; text: string; code: string; sequence: number; answers: Answer[]; }
interface Saved { detailId: string; answerId: string; }

export class SurveyControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private context!: ComponentFramework.Context<IInputs>;
  private root!: HTMLDivElement;
  private recordId = '';
  private doctorId = '';
  private productId = '';
  private questions: Question[] = [];
  private selected: { [questionId: string]: string } = {};
  private saved: { [questionId: string]: Saved } = {};
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
    const needs: string[] = [];
    if (!this.doctorId) { needs.push('doctor'); }
    if (needs.length > 0) {
      card.appendChild(this.div('sv-info', 'Please select the ' + needs.join(' and ') + ' and save the response before starting.'));
    } else {
      card.appendChild(this.div('sv-info', 'Ready to start. Click Start Survey.'));
    }
    const btn = this.button('Start Survey', 'sv-btn sv-btn-primary', () => { void this.startSurvey(); });
    btn.disabled = needs.length > 0;
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

  // ---------- THE FILTER: questions, answers, earlier picks ----------
  private async loadQuestions(): Promise<void> {
    // product on the response = product-wise survey; no product = general survey
    let filter = 'btcl_isactive eq true';
    if (this.productId) {
      filter += ' and _btcl_product_value eq ' + this.productId;
    } else {
      filter += ' and _btcl_product_value eq null';
    }
    const q = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyques', '?$select=btcl_surveyquesid,btcl_questiontext,btcl_questioncode,btcl_sequence&$filter=' + filter + '&$orderby=btcl_sequence asc');
    const list: Question[] = [];
    q.entities.forEach((e) => {
      list.push({ id: e['btcl_surveyquesid'], text: e['btcl_questiontext'], code: e['btcl_questioncode'], sequence: e['btcl_sequence'] || 0, answers: [] });
    });
    this.questions = [];
    this.selected = {};
    this.saved = {};
    if (list.length === 0) { return; }

    const idFilter = list.map((x) => '_btcl_question_value eq ' + x.id).join(' or ');
    const a = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyans', '?$select=btcl_surveyansid,btcl_answertext,btcl_answercode,btcl_sortorder,_btcl_question_value&$filter=btcl_isactive eq true and (' + idFilter + ')&$orderby=btcl_sortorder asc');
    a.entities.forEach((e) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === e['_btcl_question_value']) {
          list[i].answers.push({ id: e['btcl_surveyansid'], text: e['btcl_answertext'], code: e['btcl_answercode'] });
        }
      }
    });
    this.questions = list.filter((x) => x.answers.length > 0);

    // answers already stored for this response (if any) are pre-selected
    const d = await this.context.webAPI.retrieveMultipleRecords('btcl_surveyresdetail', '?$select=btcl_surveyresdetailid,_btcl_question_value,_btcl_selectedanswer_value&$filter=_btcl_response_value eq ' + this.recordId);
    d.entities.forEach((e) => {
      const qid = e['_btcl_question_value'];
      this.saved[qid] = { detailId: e['btcl_surveyresdetailid'], answerId: e['_btcl_selectedanswer_value'] };
      this.selected[qid] = e['_btcl_selectedanswer_value'];
    });
  }

  // ---------- draw ALL questions and their answers on one page ----------
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
        if (this.selected[this.questions[i].id]) { n++; }
      }
      counter.textContent = n + ' of ' + this.questions.length + ' answered';
      fill.style.width = Math.round((n / this.questions.length) * 100) + '%';
      submit.disabled = n < this.questions.length;
    };

    this.questions.forEach((q, qi) => {
      const block = this.div('sv-block');
      block.appendChild(this.div('sv-question', (qi + 1) + '. ' + q.text));
      const list = this.div('sv-answers');
      const buttons: HTMLButtonElement[] = [];
      q.answers.forEach((a) => {
        const b = this.button(a.text, 'sv-answer', () => {
          this.selected[q.id] = a.id;
          for (let k = 0; k < buttons.length; k++) {
            buttons[k].className = 'sv-answer' + (q.answers[k].id === a.id ? ' sv-selected' : '');
          }
          refresh();
        });
        if (this.selected[q.id] === a.id) { b.className = 'sv-answer sv-selected'; }
        buttons.push(b);
        list.appendChild(b);
      });
      block.appendChild(list);
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
      for (let i = 0; i < this.questions.length; i++) {
        const q = this.questions[i];
        const a = this.findAnswer(q, this.selected[q.id]);
        if (!a) { throw new Error('Please answer all questions before submitting.'); }
        const data: any = {
          btcl_name: q.code + ' - ' + a.code,
          btcl_questioncode: q.code,
          btcl_questiontext: q.text,
          btcl_answercode: a.code,
          btcl_answertext: a.text,
          btcl_sortorder: q.sequence,
          btcl_isrequired: true
        };
        data[NAV_DET_ANSWER + '@odata.bind'] = '/' + SET_ANS + '(' + a.id + ')';
        const existing = this.saved[q.id];
        if (existing) {
          await this.context.webAPI.updateRecord('btcl_surveyresdetail', existing.detailId, data);
        } else {
          data[NAV_DET_RESPONSE + '@odata.bind'] = '/' + SET_RES + '(' + this.recordId + ')';
          data[NAV_DET_QUESTION + '@odata.bind'] = '/' + SET_QUES + '(' + q.id + ')';
          const created = await this.context.webAPI.createRecord('btcl_surveyresdetail', data);
          this.saved[q.id] = { detailId: created.id, answerId: a.id };
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

  private findAnswer(q: Question, answerId: string): Answer | null {
    for (let i = 0; i < q.answers.length; i++) {
      if (q.answers[i].id === answerId) { return q.answers[i]; }
    }
    return null;
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