import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Modal, Alert, Vibration, Animated, Switch, RefreshControl, Platform
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';

const DEFAULT_FIREBASE_URL = 'https://SEU-FIREBASE.firebaseio.com';
const POLL_INTERVAL = 3000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const SOUND_RA_URL = 'https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg';
const SOUND_LARANJA_URL = 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg';

const CONFIG_KEY = '@v22_config';
const ALERTADOS_KEY = '@v22_alertados';

export default function App() {
  const [posicoes, setPosicoes] = useState([]);
  const [config, setConfig] = useState({
    firebaseUrl: DEFAULT_FIREBASE_URL,
    telegramToken: '',
    telegramChatId: '',
    somLaranjaAtivo: true,
    somRAAtivo: true,
  });
  const [showConfig, setShowConfig] = useState(false);
  const [showOpModal, setShowOpModal] = useState(false);
  const [opForm, setOpForm] = useState({ acao: 'compra', ticker: '', qtd: '', valor: '' });
  const [showFimModal, setShowFimModal] = useState(false);
  const [fimForm, setFimForm] = useState({ ticker: '', preco: '' });
  const [refreshing, setRefreshing] = useState(false);

  const soundLaranjaRef = useRef(null);
  const soundRARbRef = useRef(null);
  const alertadosRef = useRef({});
  const configRef = useRef(config);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Mantém configRef sincronizado (evita closure desatualizado no polling)
  useEffect(() => { configRef.current = config; }, [config]);

  // Animação de pulso
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.04, duration: 600, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
    ])).start();
  }, []);

  // Boot: carrega config + sons + alertados persistidos
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(CONFIG_KEY);
        if (saved) setConfig(JSON.parse(saved));

        const savedAlertados = await AsyncStorage.getItem(ALERTADOS_KEY);
        if (savedAlertados) alertadosRef.current = JSON.parse(savedAlertados);

        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });

        const { sound: s1 } = await Audio.Sound.createAsync(
          { uri: SOUND_LARANJA_URL }, { shouldPlay: false }
        );
        const { sound: s2 } = await Audio.Sound.createAsync(
          { uri: SOUND_RA_URL }, { shouldPlay: false }
        );
        soundLaranjaRef.current = s1;
        soundRARbRef.current = s2;
      } catch (e) {
        console.log('Erro no boot:', e);
      }
    })();

    return () => {
      soundLaranjaRef.current?.unloadAsync?.();
      soundRARbRef.current?.unloadAsync?.();
    };
  }, []);

  const salvarConfig = async () => {
    try {
      await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      if (config.telegramToken && config.telegramChatId) {
        const res = await fetch(
          `https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.telegramChatId, text: '✅ Bot V23.1 RA/RB OK!' }),
          }
        );
        const json = await res.json();
        if (!json.ok) Alert.alert('Erro Telegram', json.description);
        else Alert.alert('Sucesso', 'Config salva!');
      }
      setShowConfig(false);
    } catch (e) {
      Alert.alert('Erro', e.message);
    }
  };

  const playSound = async (tipo) => {
    try {
      const cfg = configRef.current;
      if (tipo === 'LARANJA' && !cfg.somLaranjaAtivo) return;
      if ((tipo === 'RA' || tipo === 'RB') && !cfg.somRAAtivo) return;

      Vibration.vibrate(tipo === 'LARANJA' ? [0, 300] : [0, 500, 200, 500]);

      const sound = tipo === 'LARANJA' ? soundLaranjaRef.current : soundRARbRef.current;
      if (sound) {
        await sound.setPositionAsync(0);
        await sound.playAsync();
      }
    } catch (e) {
      console.log('Erro som:', e);
    }
  };

  const parseCarteira = useCallback((raw) => {
    if (!raw) return [];
    const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
    const list = [];
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      // Mínimo: TICKER QTD ENTRADA ATUAL TIPO LUCROMAX  (6 campos)
      if (parts.length < 6) continue;

      const [ticker, qtdStr, entradaStr, atualStr, tipo, lucroMaxStr] = parts;
      const sinalRaw = (parts[6] || '').toUpperCase();

      const qtd = parseFloat(qtdStr);
      const entrada = parseFloat(entradaStr);
      const atual = parseFloat(atualStr);
      const lucroMax = parseFloat(lucroMaxStr);

      if ([qtd, entrada, atual, lucroMax].some(isNaN)) continue;

      const isV = tipo.toUpperCase() === 'V';
      const investido = qtd * entrada;
      const totalAtual = qtd * atual;
      const lucro = isV ? (entrada - atual) * qtd : (atual - entrada) * qtd;
      const lucroPct = investido !== 0 ? (lucro / investido) * 100 : 0;

      const isLaranja = lucroMax > 0 && lucro < lucroMax * 0.75;
      const isRA = sinalRaw === 'RA';
      const isRB = sinalRaw === 'RB';

      list.push({
        id: ticker, ticker, qtd, entrada, atual,
        tipo: isV ? 'V' : 'C', lucroMax, sinal: sinalRaw,
        isLaranja, isRA, isRB,
        investido, totalAtual, lucro, lucroPct,
      });
    }
    return list;
  }, []);

  const checkAlerts = useCallback((posicoesList) => {
    const now = Date.now();
    let mudou = false;

    posicoesList.forEach(p => {
      if (p.isRA || p.isRB) {
        const key = `${p.ticker}-${p.sinal}`;
        if (now - (alertadosRef.current[key] || 0) > ALERT_COOLDOWN_MS) {
          playSound(p.sinal);
          alertadosRef.current[key] = now;
          mudou = true;
        }
      }
      if (p.isLaranja && !p.isRA && !p.isRB) {
        const key = `${p.ticker}-LARANJA`;
        if (now - (alertadosRef.current[key] || 0) > ALERT_COOLDOWN_MS) {
          playSound('LARANJA');
          alertadosRef.current[key] = now;
          mudou = true;
        }
      }
    });

    if (mudou) {
      AsyncStorage.setItem(ALERTADOS_KEY, JSON.stringify(alertadosRef.current)).catch(() => {});
    }
  }, []);

  const fetchCarteira = useCallback(async () => {
    try {
      const cfg = configRef.current;
      if (!cfg.firebaseUrl || cfg.firebaseUrl.includes('SEU-FIREBASE')) return;

      const url = cfg.firebaseUrl.replace(/\/$/, '') + '/carteira.json';
      const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
      const data = await res.json();

      const raw = typeof data === 'string'
        ? data
        : (data?.valor || data?.carteira || (data?.dados) || '');

      if (raw) {
        const parsed = parseCarteira(raw);
        setPosicoes(parsed);
        checkAlerts(parsed);
      }
    } catch (e) {
      console.log('Erro fetch:', e);
    }
  }, [parseCarteira, checkAlerts]);

  useEffect(() => {
    fetchCarteira();
    const id = setInterval(fetchCarteira, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchCarteira, config.firebaseUrl]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchCarteira();
    setRefreshing(false);
  };

  const enviarTelegram = async (texto) => {
    const cfg = configRef.current;
    if (!cfg.telegramToken || !cfg.telegramChatId) {
      Alert.alert('Configure Telegram', 'Vá em ⚙️');
      return false;
    }
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.telegramChatId, text: texto }),
        }
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.description);
      return true;
    } catch (e) {
      Alert.alert('Erro Telegram', e.message);
      return false;
    }
  };

  const totalInvestido = posicoes.reduce((s, p) => s + p.investido, 0);
  const totalAtualGeral = posicoes.reduce((s, p) => s + p.totalAtual, 0);

  // ✅ CORREÇÃO: soma o lucro de cada posição (já vem com o sinal correto do parseCarteira)
  // Não usar `totalAtualGeral - totalInvestido`, pois isso só vale para posições de COMPRA (C).
  // Para posições de VENDA (V), o lucro tem o sinal invertido e a conta quebrava.
  const lucroTotal = posicoes.reduce((s, p) => s + p.lucro, 0);
  const lucroTotalPct = totalInvestido ? (lucroTotal / totalInvestido) * 100 : 0;

  const raRbCount = posicoes.filter(p => p.isRA || p.isRB).length;
  const laranjaCount = posicoes.filter(p => p.isLaranja).length;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar style="light" />

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Swing V23.1</Text>
          <View style={styles.alertHeader}>
            {raRbCount > 0 && <Text style={styles.alertHeaderTextRA}>🔄 {raRbCount} RA/RB</Text>}
            {laranjaCount > 0 && <Text style={styles.alertHeaderTextLaranja}>⚠️ {laranjaCount}</Text>}
          </View>
          <TouchableOpacity onPress={() => setShowConfig(true)} style={styles.configBtn}>
            <Text style={styles.configBtnText}>⚙️</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>TOTAL CARTEIRA</Text>
          <Text style={styles.totalValue}>R$ {totalAtualGeral.toFixed(2)}</Text>
          <View style={styles.totalRow}>
            <Text style={styles.totalSub}>Investido R$ {totalInvestido.toFixed(2)}</Text>
            <Text style={[styles.totalSub, { color: lucroTotal >= 0 ? '#30D158' : '#FF453A' }]}>
              {lucroTotal >= 0 ? '▲' : '▼'} {lucroTotal.toFixed(2)} ({lucroTotalPct.toFixed(2)}%)
            </Text>
          </View>
        </View>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#30D158' }]}
            onPress={() => { setOpForm({ acao: 'compra', ticker: '', qtd: '', valor: '' }); setShowOpModal(true); }}
          >
            <Text style={styles.actionBtnText}>COMPRA</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#FF3B30' }]}
            onPress={() => { setOpForm({ acao: 'venda', ticker: '', qtd: '', valor: '' }); setShowOpModal(true); }}
          >
            <Text style={styles.actionBtnText}>VENDA</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {posicoes.map(p => {
            const isAlertCard = p.isRA || p.isRB;
            return (
              <Animated.View
                key={p.ticker}
                style={isAlertCard ? { transform: [{ scale: pulseAnim }] } : {}}
              >
                <View style={[styles.card, p.isLaranja && styles.cardLaranja, isAlertCard && styles.cardRA]}>
                  {isAlertCard && (
                    <View style={styles.badgeRA}>
                      <Text style={styles.badgeRAText}>
                        {p.isRA ? '🔄 RA - REVERSÃO DE ALTA' : '🔻 RB - REVERSÃO DE BAIXA'}
                      </Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.closeX}
                    onPress={() => { setFimForm({ ticker: p.ticker, preco: String(p.atual) }); setShowFimModal(true); }}
                  >
                    <Text style={styles.closeXText}>✕</Text>
                  </TouchableOpacity>

                  <View style={styles.cardRow}>
                    <Text style={styles.ticker}>{p.ticker}</Text>
                    <View style={[styles.badgeTipo, { backgroundColor: p.tipo === 'V' ? '#FF9500' : '#1A9A8C' }]}>
                      <Text style={styles.badgeTipoText}>{p.tipo}</Text>
                    </View>
                    {p.isLaranja && (
                      <View style={styles.badgeLaranja}>
                        <Text style={styles.badgeLaranjaText}>⚠️ 75%</Text>
                      </View>
                    )}
                  </View>

                  <View style={styles.cardRow}>
                    <Text style={styles.cardText}>
                      Qtd {p.qtd} | {p.tipo === 'V' ? 'Vendido' : 'Comprado'} {p.entrada.toFixed(2)} → {p.atual.toFixed(2)}
                    </Text>
                  </View>

                  <View style={styles.cardRow}>
                    <Text style={styles.cardSmall}>Lucro Max R$ {p.lucroMax.toFixed(2)}</Text>
                  </View>

                  <View style={styles.cardRowSpace}>
                    <Text style={styles.cardTotal}>Total R$ {p.totalAtual.toFixed(2)}</Text>
                    <Text style={[styles.cardLucro, { color: p.lucro >= 0 ? '#30D158' : '#FF3B30' }]}>
                      {p.lucro >= 0 ? '▲' : '▼'} {p.lucro.toFixed(2)} ({p.lucroPct.toFixed(2)}%)
                    </Text>
                  </View>
                </View>
              </Animated.View>
            );
          })}
          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Modal COMPRA/VENDA */}
        <Modal visible={showOpModal} transparent animationType="slide">
          <View style={styles.modalBg}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{opForm.acao.toUpperCase()}</Text>
              <TextInput
                placeholder="Ticker"
                value={opForm.ticker}
                onChangeText={v => setOpForm({ ...opForm, ticker: v.toUpperCase() })}
                style={styles.input}
              />
              <TextInput
                placeholder="Quantidade"
                keyboardType="numeric"
                value={opForm.qtd}
                onChangeText={v => setOpForm({ ...opForm, qtd: v })}
                style={styles.input}
              />
              <TextInput
                placeholder="Valor"
                keyboardType="numeric"
                value={opForm.valor}
                onChangeText={v => setOpForm({ ...opForm, valor: v })}
                style={styles.input}
              />
              <View style={styles.modalRow}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setShowOpModal(false)}>
                  <Text style={styles.modalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalConfirm}
                  onPress={async () => {
                    const txt = `/op ${opForm.ticker} ${opForm.qtd} ${opForm.valor} ${opForm.acao}`;
                    if (await enviarTelegram(txt)) setShowOpModal(false);
                  }}
                >
                  <Text style={styles.modalConfirmText}>Enviar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal FECHAR */}
        <Modal visible={showFimModal} transparent animationType="slide">
          <View style={styles.modalBg}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>FECHAR POSIÇÃO</Text>
              <TextInput
                placeholder="Ticker"
                value={fimForm.ticker}
                onChangeText={v => setFimForm({ ...fimForm, ticker: v.toUpperCase() })}
                style={styles.input}
              />
              <TextInput
                placeholder="Preço fechamento"
                keyboardType="numeric"
                value={fimForm.preco}
                onChangeText={v => setFimForm({ ...fimForm, preco: v })}
                style={styles.input}
              />
              <View style={styles.modalRow}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setShowFimModal(false)}>
                  <Text style={styles.modalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalConfirm, { backgroundColor: '#FF3B30' }]}
                  onPress={async () => {
                    const txt = `/fim ${fimForm.ticker} ${fimForm.preco}`;
                    if (await enviarTelegram(txt)) setShowFimModal(false);
                  }}
                >
                  <Text style={styles.modalConfirmText}>Fechar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal CONFIG */}
        <Modal visible={showConfig} transparent animationType="slide">
          <View style={styles.modalBg}>
            <View style={[styles.modalCard, { maxHeight: '90%' }]}>
              <ScrollView>
                <Text style={styles.modalTitle}>Configurações V23.1</Text>

                <Text style={styles.label}>Firebase URL</Text>
                <TextInput
                  value={config.firebaseUrl}
                  onChangeText={v => setConfig({ ...config, firebaseUrl: v })}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <Text style={styles.label}>Telegram Bot Token</Text>
                <TextInput
                  value={config.telegramToken}
                  onChangeText={v => setConfig({ ...config, telegramToken: v })}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <Text style={styles.label}>Telegram Chat ID</Text>
                <TextInput
                  value={config.telegramChatId}
                  onChangeText={v => setConfig({ ...config, telegramChatId: v })}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <Text style={[styles.label, { marginTop: 16, fontSize: 14 }]}>🔊 Alertas Sonoros</Text>

                <View style={styles.switchRow}>
                  <Text style={styles.label}>⚠️ Som Tag Laranja (&lt;75% Max)</Text>
                  <Switch
                    value={config.somLaranjaAtivo}
                    onValueChange={v => setConfig({ ...config, somLaranjaAtivo: v })}
                  />
                </View>

                <View style={styles.switchRow}>
                  <Text style={styles.label}>🚨 Som RA/RB (mesmo som urgência)</Text>
                  <Switch
                    value={config.somRAAtivo}
                    onValueChange={v => setConfig({ ...config, somRAAtivo: v })}
                  />
                </View>

                <Text style={styles.helpText}>
                  Formato Firebase: TICKER QTD ENTRADA ATUAL TIPO LUCROMAX [RA|RB];{'\n'}
                  Ex: VALEV694 1000 0.72 0.53 V 229.99 RA{'\n'}
                  Ex: PETR4 100 42.5 44.2 C 150.00 RB{'\n'}
                  RA=Reversão Alta, RB=Reversão Baixa - mesmo som + borda vermelha pulsante.{'\n'}
                  Cooldown 5min pra não spammar.
                </Text>

                <View style={styles.modalRow}>
                  <TouchableOpacity style={styles.modalCancel} onPress={() => setShowConfig(false)}>
                    <Text style={styles.modalCancelText}>Fechar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalConfirm} onPress={salvarConfig}>
                    <Text style={styles.modalConfirmText}>Salvar e Testar</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  alertHeader: { flexDirection: 'row', gap: 8 },
  alertHeaderTextRA: {
    color: '#FF3B30', fontWeight: '900', backgroundColor: '#FF3B3020',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, overflow: 'hidden',
  },
  alertHeaderTextLaranja: {
    color: '#FF9500', fontWeight: '900', backgroundColor: '#FF950020',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, overflow: 'hidden',
  },
  configBtn: { padding: 8 },
  configBtnText: { fontSize: 22 },

  totalCard: { backgroundColor: '#1C1C1E', marginHorizontal: 16, padding: 16, borderRadius: 20 },
  totalLabel: { color: '#8E8E93', fontSize: 12, fontWeight: '700' },
  totalValue: { color: '#fff', fontSize: 28, fontWeight: '900', marginTop: 4 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  totalSub: { color: '#8E8E93', fontSize: 12 },

  actionsRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, marginTop: 12, marginBottom: 12 },
  actionBtn: { flex: 1, padding: 14, borderRadius: 14, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontWeight: '900' },

  list: { flex: 1, paddingHorizontal: 16 },
  card: { backgroundColor: '#F2F2F7', borderRadius: 20, padding: 14, marginBottom: 12, borderWidth: 0 },
  cardLaranja: { borderWidth: 2, borderColor: '#FF9500' },
  cardRA: { borderWidth: 3, borderColor: '#FF3B30', backgroundColor: '#FFF0F0' },
  badgeRA: {
    backgroundColor: '#FF3B30', borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8,
    alignSelf: 'flex-start', marginBottom: 8,
  },
  badgeRAText: { color: '#fff', fontWeight: '900', fontSize: 11 },
  closeX: { position: 'absolute', top: 6, right: 6, padding: 6, zIndex: 10 },
  closeXText: { color: '#FF3B30', fontSize: 18, fontWeight: '900' },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  cardRowSpace: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  ticker: { fontSize: 16, fontWeight: '900', color: '#000' },
  badgeTipo: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeTipoText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  badgeLaranja: { backgroundColor: '#FF9500', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeLaranjaText: { color: '#fff', fontWeight: '800', fontSize: 10 },
  cardText: { color: '#1C1C1E', fontSize: 13, fontWeight: '600' },
  cardSmall: { color: '#8E8E93', fontSize: 11 },
  cardTotal: { fontWeight: '800', fontSize: 13 },
  cardLucro: { fontWeight: '900', fontSize: 13 },

  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#fff', borderRadius: 20, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: '900', marginBottom: 12, textAlign: 'center' },
  input: {
    borderWidth: 1, borderColor: '#E5E5EA', borderRadius: 12, padding: 12,
    marginBottom: 12, backgroundColor: '#F2F2F7',
  },
  label: { fontSize: 12, fontWeight: '700', color: '#8E8E93', marginBottom: 4, marginTop: 4 },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginVertical: 8, backgroundColor: '#F2F2F7', padding: 12, borderRadius: 12,
  },
  modalRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  modalCancel: { flex: 1, backgroundColor: '#E5E5EA', padding: 14, borderRadius: 12, alignItems: 'center' },
  modalCancelText: { fontWeight: '800', color: '#000' },
  modalConfirm: { flex: 1, backgroundColor: '#007AFF', padding: 14, borderRadius: 12, alignItems: 'center' },
  modalConfirmText: { fontWeight: '900', color: '#fff' },
  helpText: { fontSize: 11, color: '#8E8E93', marginTop: 12, lineHeight: 16 },
});