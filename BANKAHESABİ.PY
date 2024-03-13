import hashlib

class bankahesabi:
    def __init__(self):
        self.isim = input("LÜTFEN İSMİNİZİ GRİNİZ:")
        self.soyisim = input("LÜTFEN soyİSMİNİZİ GRİNİZ:")
        self.numara = int(input("LÜTFEN NUMARANİZİ GRİNİZ:"))
        self.para_miktari = int(input("LÜTFEN PARA MİKTARİNİZ GRİNİZ:"))
        self.sifre = int(input("LÜTFEN YENİ SİFRENİZİ GRİNİZ:")) 
        print("tesekürler...")
        self.isim_list = [self.isim]
        self.soyisim_list = [self.soyisim]
        self.numara_list = [self.numara]
        self.para_miktari_list = [self.para_miktari]
        sifre_hash = hashlib.md5(str(self.sifre).encode()).hexdigest()
        self.sifre_list = {}
        self.sifre_list[self.isim] = sifre_hash
        cevap2=input("baska islem yapmak istiyor musunuz")
        if cevap2=="evet":
            anasayfa()
        else:
            print("iyi günler")
            exit()
    def yatir(self):
        isimg = input("İsminiz nedir?")
        for i in range(len(self.isim_list)):
            if isimg == self.isim_list[i]:
                sifreg = input("Şifrenizi giriniz:")
                if sifreg == self.sifre_list[self.isim]:
                    yatir = int(input("Ne kadar para yatırmak istiyorsunuz:"))
                    self.para_miktari_list[i] += yatir
                    print("Para yatırma işlemi başarılı.")
                    return
                else:
                    print("Hatalı şifre.")
                    return

    def paracek(self):
        isimg = input("İsminiz nedir?")
        for i in range(len(self.isim_list)):
            if isimg == self.isim_list[i]:
                sifreg = input("Şifrenizi giriniz:")
                if sifreg == self.sifre_list[self.isim]:
                    cekim = int(input("Ne kadar para çekmek istiyorsunuz:"))
                    if self.para_miktari_list[i] >= cekim:
                        sonuc = self.para_miktari_list[i] - cekim
                        self.para_miktari_list[i] = sonuc
                        print("Para çekme işlemi başarılı.")
                    else:
                        print("Yetersiz bakiye.")
                    return
                else:
                    print("Hatalı şifre.")
                    return
        print("Hesap bulunamadı.")

def anasayfa():
    islem=input("hangi yapmak istiyorsunuz(a) kayit \n b) para cek \n c) para yatir \n")
    if islem=="a":
        nesne=bankahesabi()
    elif islem == "b":
        nesne.paracek
    elif islem=="c":
        nesne.yatir
    else: 
        print("yanlis kod girdiniz, lütfen tekrar giriniz")
        anasayfa()  
if __name__ == "__main__":
    anasayfa() 