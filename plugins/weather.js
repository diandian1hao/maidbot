// plugins/weather.js - 终极整合版（QQ详细播报 + 早报高密度简报 + 预警）
const KEY = process.env.QWEATHER_KEY;
const LOC = process.env.QWEATHER_LOCATION;
const HOST = (process.env.QWEATHER_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const H = `https://${HOST}/v7`;
const GEO_H = `https://${HOST}/geo/v2`;

// 内置城市字典，防止 GeoAPI 权限失效
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
  '新余':'101240801','香港':'101320101','澳门':'101330101','台北':'101340101'
};

class WeatherPlugin {
  constructor(bot) {
    this.name = 'weather';
    this.priority = 55;
    this.bot = bot;
    this._seen = new Set();
    this._bootDone = false;
    this._startWarnPoll();
    console.log(`[Weather] 🌤️ 天气插件已就绪，HOST: ${HOST || '未配置'}`);
  }

  // ================= 1. 处理 QQ 聊天消息 =================
  async handleMessage(msgData) {
    const text = (msgData?.content || '').trim();
    if (!text) return null;

    const m = text.match(/(?:查)?天气\s*([^\s,，。！？!?]*)|([^\s,，。！？!?]*)\s*(?:的)?天气|weather\s*([^\s,，。！？!?]*)/i);
    if (!m) return null;

    let cityName = (m[1] || m[2] || m[3] || '').trim();
    cityName = cityName.replace(/^(今天|明天|现在|查|帮我查查|看|一下|的|在)/g, '').replace(/的$/, '').replace(/[如何怎么样呢啊呀]/g, '').trim();

    try {
      let targetName = cityName || '默认城市';
      let locationId = LOC;

      if (cityName) {
        if (CITY_MAP[cityName]) {
          locationId = CITY_MAP[cityName];
        } else {
          const geo = await this._fetchGeo(cityName);
          if (geo) {
            targetName = geo.name;
            locationId = geo.id;
          } else {
            throw new Error(`找不到"${cityName}"，试试输入常用城市名`);
          }
        }
      }

      const [nowRes, h24Res, d3Res] = await Promise.all([
        this._fetchWeather('now', locationId),
        this._fetchWeather('24h', locationId),
        this._fetchWeather('3d', locationId)
      ]);

      if (nowRes.code !== '200') throw new Error(`天气接口异常: ${nowRes.code}`);

      const now = nowRes.now;
      let msg = `主人，${targetName}的天气为您播报 ☁️\n\n`;
      msg += `🌤 实时：${now.text} ${now.temp}°C，体感${now.feelsLike}°C\n`;
      msg += `${now.windDir}${now.windScale}级，湿度${now.humidity}%\n\n`;

      if (h24Res.code === '200' && h24Res.hourly) {
        msg += `⏱ 未来6小时：\n`;
        h24Res.hourly.slice(0, 6).forEach(h => {
          msg += `  ${h.fxTime.substring(11, 16)} ${h.text} ${h.temp}°C\n`;
        });
        msg += `\n`;
      }

      if (d3Res.code === '200' && d3Res.daily) {
        msg += `📅 未来3天：\n`;
        const days = ['今天', '明天', '后天'];
        d3Res.daily.forEach((d, i) => {
          msg += `  ${days[i] || d.fxDate}：${d.textDay}，${d.tempMin}~${d.tempMax}°C\n`;
        });
      }

      return msg.trim();
    } catch (e) {
      console.error('[Weather] 聊天查询失败:', e.message);
      return `呜...气象卫星失联了 (${e.message})，稍后再问我好不好？`;
    }
  }

  // ================= 2. 供早报调用的接口 =================
  async getBrief() {
    return this.getBriefByCity(null);
  }

  async getBriefByCity(cityName) {
    let locationId = LOC;
    let targetName = cityName || '默认城市';

    if (cityName) {
      if (CITY_MAP[cityName]) {
        locationId = CITY_MAP[cityName];
      } else {
        const geo = await this._fetchGeo(cityName);
        if (geo) {
          targetName = geo.name;
          locationId = geo.id;
        }
      }
    }

    try {
      const [nowRes, d3Res] = await Promise.all([
        this._fetchWeather('now', locationId),
        this._fetchWeather('3d', locationId)
      ]);

      if (nowRes.code !== '200') throw new Error('天气接口异常');
      
      const now = nowRes.now;
      let brief = `【实时】${now.text} ${now.temp}°C，体感${now.feelsLike}°C，${now.windDir}${now.windScale}级，湿度${now.humidity}%。\n`;
      
      if (d3Res.code === '200' && d3Res.daily && d3Res.daily.length >= 2) {
        const today = d3Res.daily[0];
        const tomorrow = d3Res.daily[1];
        brief += `【今日】白天${today.textDay}，夜间${today.textNight}，气温${today.tempMin}~${today.tempMax}°C。\n`;
        brief += `【明日】${tomorrow.textDay}，气温${tomorrow.tempMin}~${tomorrow.tempMax}°C。`;
      }
      
      return brief;
    } catch (e) {
      console.error('[Weather] 早报接口失败:', e.message);
      return '暂无法获取详细天气信息';
    }
  }

  // ================= 3. 内部工具 =================
  async _fetchWeather(endpoint, locationId) {
    if (!HOST || !KEY) return { code: '401' };
    const url = `${H}/weather/${endpoint}?location=${locationId}&key=${KEY}`;
    return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json());
  }

  async _fetchGeo(cityName) {
    if (!HOST || !KEY) return null;
    const url = `${GEO_H}/city/lookup?location=${encodeURIComponent(cityName)}&key=${KEY}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await res.text();
      if (res.status === 403) return null;
      const j = JSON.parse(text);
      if (j.code === '200' && j.location && j.location.length > 0) {
        return j.location[0];
      }
    } catch (e) {}
    return null;
  }

  _startWarnPoll() {
    const poll = async () => {
      if (!KEY || !LOC || !HOST) return;
      try {
        const j = await this._fetchWeather('warning/now', LOC);
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
      } catch (e) {}
    };
    poll();
    this._timer = setInterval(poll, 30 * 60 * 1000);
    this._timer.unref?.();
  }
}

module.exports = WeatherPlugin;
