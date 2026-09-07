// plugins/weather.js - 天气数据源 + 灾害预警 + 关键词响应（无需 GeoAPI）
const KEY = process.env.QWEATHER_KEY;
const LOC = process.env.QWEATHER_LOCATION;
const HOST = (process.env.QWEATHER_HOST || 'devapi.qweather.com')
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');
const H = `https://${HOST}/v7`;

// ⭐ 内置常用城市 Location ID（和风天气官方固定 ID，无需 GeoAPI）
const CITY_MAP = {
  '北京':'101010100','上海':'101020100','广州':'101280101','深圳':'101280601',
  '成都':'101270101','杭州':'101210101','武汉':'101200101','西安':'101110101',
  '南京':'101190101','重庆':'101040100','天津':'101030100','苏州':'101190401',
  '长沙':'101250101','郑州':'101180101','东莞':'101281601','青岛':'101120201',
  '沈阳':'101070101','大连':'101070201','宁波':'101210401','厦门':'101230201',
  '福州':'101230101','无锡':'101190201','合肥':'101220101','昆明':'101290101',
  '哈尔滨':'101050101','济南':'101120101','佛山':'101280800','南宁':'101300101',
  '温州':'101210701','石家庄':'101090101','贵阳':'101260101','南昌':'101240101',
  '金华':'101210901','珠海':'101280701','惠州':'101280301','徐州':'101190801',
  '海口':'101310101','乌鲁木齐':'101130101','绍兴':'101210501','中山':'101281701',
  '台州':'101210601','兰州':'101160101','潍坊':'101120601','保定':'101090201',
  '镇江':'101190301','扬州':'101190601','桂林':'101300501','唐山':'101090501',
  '三亚':'101310201','湖州':'101210201','呼和浩特':'101080101','廊坊':'101090601',
  '洛阳':'101180901','威海':'101121301','盐城':'101190701','临沂':'101120901',
  '江门':'101281101','汕头':'101280501','泰州':'101191201','漳州':'101230601',
  '邯郸':'101091001','济宁':'101120701','芜湖':'101220301','淄博':'101120301',
  '银川':'101170101','柳州':'101300301','绵阳':'101270401','湛江':'101281001',
  '鞍山':'101070301','赣州':'101240701','大庆':'101050901','宜昌':'101200901',
  '包头':'101080201','咸阳':'101110200','秦皇岛':'101091101','株洲':'101250301',
  '莆田':'101230401','吉林':'101060201','安庆':'101220801','宿州':'101221201',
  '香港':'101320101','澳门':'101330101','台北':'101340101',
};

class WeatherPlugin {
  constructor(bot) {
    this.name = 'weather';
    this.priority = 55;
    this.bot = bot;
    this._seen = new Set();
    this._bootDone = false;
    this._startWarnPoll();
    console.log('[Weather] 🌤️ 天气插件已就绪 →', HOST);
  }

  async handleMessage(msgData) {
    const text = (msgData?.content || '').trim();
    if (!text) return null;

    const m = text.match(/(?:查)?天气\s*([^\s,，。！？!?]*)|([^\s,，。！？!?]*)\s*(?:的)?天气|weather\s*([^\s,，。！？!?]*)/i);
    if (!m) return null;

    const cityName = (m[1] || m[2] || m[3] || '').trim();

    try {
      let brief;
      if (!cityName) {
        brief = await this.getBrief();
      } else {
        brief = await this.getBriefByCity(cityName);
      }
      const target = cityName || '这里';
      return `主人，${target}现在的天气是：${brief} ☁️\n出门记得看情况增减衣物哦~`;
    } catch (e) {
      console.error('[Weather] 查询失败:', e.message);
      return `呜...气象卫星失联了 (${e.message})，稍后再问我好不好？`;
    }
  }

  async getBrief() {
    if (!KEY || !LOC) throw new Error('未配置 QWEATHER_KEY / QWEATHER_LOCATION');
    return this._fetchBrief(LOC);
  }

  async getBriefByCity(cityName) {
    if (!KEY) throw new Error('未配置 QWEATHER_KEY');

    // 策略1：直接把城市名塞进天气接口（部分 KEY 支持）
    try {
      return await this._fetchBrief(cityName);
    } catch (e1) {
      // 策略2：查内置城市表
      const id = CITY_MAP[cityName];
      if (id) return this._fetchBrief(id);
      // 都不行
      const hint = Object.keys(CITY_MAP).slice(0, 8).join('、');
      throw new Error(`找不到"${cityName}"，试试这些：${hint}...`);
    }
  }

  async _fetchBrief(location) {
    const j = await fetch(`${H}/weather/now?location=${encodeURIComponent(location)}&key=${KEY}`).then(r => r.json());
    if (j.code !== '200') throw new Error(`QWeather code=${j.code}`);
    const n = j.now;
    return `${n.text} ${n.temp}°C，体感${n.feelsLike}°C，${n.windDir}${n.windScale}级，湿度${n.humidity}%`;
  }

  _startWarnPoll() {
    const poll = async () => {
      if (!KEY || !LOC) return;
      try {
        const j = await fetch(`${H}/warning/now?location=${LOC}&key=${KEY}`).then(r => r.json());
        for (const w of (j.warning || [])) {
          if (this._seen.has(w.id)) continue;
          this._seen.add(w.id);
          if (!this._bootDone) continue;
          try {
            const { push } = require('../core/push');
            await push(`⚠️【天气预警】${w.typeName} ${w.levelText}\n${w.text}\n――来自你家女仆的气象监视`);
          } catch (e) { console.error('[Weather] 预警推送失败:', e.message); }
        }
        this._bootDone = true;
      } catch (e) { /* 网络抖动跳过本轮 */ }
    };
    poll();
    this._timer = setInterval(poll, 30 * 60 * 1000);
    this._timer.unref?.();
  }
}

module.exports = WeatherPlugin;
